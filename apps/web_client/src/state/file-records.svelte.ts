import { modbusAdapter } from "../lib/adapters/WebModbusAdapter";
import { connectionState } from "./connection.svelte";
import { addLog } from "./logs.svelte";
import { notifyError, notifyInfo, notifyWarning } from "./notifications.svelte";
import { getSettingsSnapshot } from "./settings.svelte";

export type FileRecordMode = "read" | "write";

export interface FileRecordSegment {
	id: string;
	fileNumber: number;
	recordNumber: number;
	wordCount: number;
	writeValuesText: string;
}

export interface ParsedFileRecordSegment {
	index: number;
	referenceType: number;
	fileNumber: number;
	recordNumber: number;
	wordCount: number;
	values: number[];
}

export interface FileRecordExecution {
	id: string;
	mode: FileRecordMode;
	functionCode: number;
	requestHex: string;
	responseHex: string;
	requestSummary: string;
	responseSummary: string;
	startedAt: number;
	durationMs: number;
	segments: FileRecordSegment[];
	parsedSegments: ParsedFileRecordSegment[];
}

interface BackendCustomFrameResponse {
	functionCode: number;
	requestHex: string;
	responseHex: string;
	requestSummary: string;
	responseSummary: string;
}

interface StoredFileRecordScenario {
	name: string;
	mode: FileRecordMode;
	pollInterval: number;
	segments: FileRecordSegment[];
}

const FILE_RECORD_POLL_INTERVAL_MIN = 200;
const FILE_RECORD_POLL_INTERVAL_MAX = 60000;
const FILE_RECORD_HISTORY_LIMIT = 12;
const FILE_RECORD_SCENARIOS_KEY = "Modbus-Lab.client.file-records.scenarios";
const FILE_RECORD_WORD_COUNT_MAX = 120;

let pollTimer: ReturnType<typeof setInterval> | null = null;

function makeId(prefix: string): string {
	const seed = Math.floor(Math.random() * 0xFFFF_FFFF)
		.toString(16)
		.padStart(8, "0");
	return `${prefix}-${Date.now()}-${seed}`;
}

function createDefaultSegment(): FileRecordSegment {
	return {
		id: makeId("seg"),
		fileNumber: 1,
		recordNumber: 0,
		wordCount: 1,
		writeValuesText: "0",
	};
}

function cloneSegment(segment: FileRecordSegment): FileRecordSegment {
	return {
		id: makeId("seg"),
		fileNumber: clampWord(segment.fileNumber),
		recordNumber: clampWord(segment.recordNumber),
		wordCount: clampWordCount(segment.wordCount),
		writeValuesText: segment.writeValuesText,
	};
}

function clampWord(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(65535, Math.floor(value)));
}

function clampWordCount(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(FILE_RECORD_WORD_COUNT_MAX, Math.floor(value)));
}

function clampPollInterval(value: number): number {
	if (!Number.isFinite(value)) return 1000;
	return Math.max(FILE_RECORD_POLL_INTERVAL_MIN, Math.min(FILE_RECORD_POLL_INTERVAL_MAX, Math.floor(value)));
}

function parseInvokeError(err: unknown): string {
	if (typeof err === "string") {
		try {
			const parsed = JSON.parse(err) as { message?: string; details?: string };
			const msg = parsed.message ?? err;
			return parsed.details ? `${msg}: ${parsed.details}` : msg;
		} catch {
			return err;
		}
	}

	if (typeof err === "object" && err !== null) {
		const parsed = err as { message?: unknown; details?: unknown };
		const msg = parsed.message != null ? String(parsed.message) : "Unknown error";
		return parsed.details != null ? `${msg}: ${String(parsed.details)}` : msg;
	}

	return "Unknown error";
}

function parseWordToken(token: string): number | null {
	const trimmed = token.trim();
	if (trimmed.length === 0) return null;

	let parsed: number;
	if (/^0x[0-9a-f]+$/i.test(trimmed)) {
		parsed = Number.parseInt(trimmed.slice(2), 16);
	} else {
		parsed = Number(trimmed);
	}

	if (!Number.isFinite(parsed)) return null;
	if (parsed < 0 || parsed > 65535) return null;
	return Math.floor(parsed);
}

function parseWordValues(raw: string): number[] {
	const tokens = raw
		.split(/[\s,;]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

	const words: number[] = [];
	for (const token of tokens) {
		const parsed = parseWordToken(token);
		if (parsed === null) {
			throw new Error(`Invalid word value '${token}'. Use 0..65535 or 0x0000..0xFFFF.`);
		}
		words.push(parsed);
	}

	return words;
}

function bytesToHex(bytes: number[]): string {
	return bytes
		.map((byte) => (byte & 0xFF).toString(16).toUpperCase().padStart(2, "0"))
		.join("");
}

function parseHexToBytes(hex: string): number[] {
	const cleaned = hex.replace(/[^0-9a-f]/gi, "");
	if (cleaned.length === 0) return [];
	if (cleaned.length % 2 !== 0) {
		throw new Error("Response hex has odd length.");
	}

	const bytes: number[] = [];
	for (let i = 0; i < cleaned.length; i += 2) {
		bytes.push(Number.parseInt(cleaned.slice(i, i + 2), 16));
	}
	return bytes;
}

function copySegments(segments: FileRecordSegment[]): FileRecordSegment[] {
	return segments.map((segment) => ({ ...segment }));
}

function buildReadPayload(segments: FileRecordSegment[]): number[] {
	if (segments.length === 0) {
		throw new Error("Add at least one read segment.");
	}

	if (segments.length > 35) {
		throw new Error("FC20 supports at most 35 read segments per request.");
	}

	const body: number[] = [];
	for (const segment of segments) {
		const fileNumber = clampWord(segment.fileNumber);
		const recordNumber = clampWord(segment.recordNumber);
		const wordCount = clampWordCount(segment.wordCount);
		body.push(
			0x06,
			(fileNumber >> 8) & 0xFF,
			fileNumber & 0xFF,
			(recordNumber >> 8) & 0xFF,
			recordNumber & 0xFF,
			(wordCount >> 8) & 0xFF,
			wordCount & 0xFF,
		);
	}

	if (body.length > 250) {
		throw new Error("Read request payload too large for one Modbus PDU.");
	}

	return [body.length, ...body];
}

function buildWritePayload(segments: FileRecordSegment[]): number[] {
	if (segments.length === 0) {
		throw new Error("Add at least one write segment.");
	}

	const body: number[] = [];

	for (const segment of segments) {
		const fileNumber = clampWord(segment.fileNumber);
		const recordNumber = clampWord(segment.recordNumber);
		const wordCount = clampWordCount(segment.wordCount);
		const writeValues = parseWordValues(segment.writeValuesText);

		if (writeValues.length !== wordCount) {
			throw new Error(
				`Segment F${fileNumber}/R${recordNumber} expects ${wordCount} values, got ${writeValues.length}.`,
			);
		}

		body.push(
			0x06,
			(fileNumber >> 8) & 0xFF,
			fileNumber & 0xFF,
			(recordNumber >> 8) & 0xFF,
			recordNumber & 0xFF,
			(wordCount >> 8) & 0xFF,
			wordCount & 0xFF,
		);

		for (const value of writeValues) {
			body.push((value >> 8) & 0xFF, value & 0xFF);
		}
	}

	if (body.length > 250) {
		throw new Error("Write request payload too large for one Modbus PDU.");
	}

	return [body.length, ...body];
}

function parseReadResponseSegments(
	payloadBytes: number[],
	requestSegments: FileRecordSegment[],
): ParsedFileRecordSegment[] {
	if (payloadBytes.length === 0) return [];

	const byteCount = payloadBytes[0] ?? 0;
	const expectedPayloadLength = payloadBytes.length - 1;
	if (byteCount !== expectedPayloadLength) {
		throw new Error(`FC20 response byte count mismatch (header=${byteCount}, actual=${expectedPayloadLength}).`);
	}

	let cursor = 1;
	let index = 0;
	const parsed: ParsedFileRecordSegment[] = [];

	while (cursor < payloadBytes.length) {
		const responseLength = payloadBytes[cursor] ?? 0;
		cursor += 1;
		if (responseLength < 1) {
			throw new Error("FC20 response has invalid sub-response length.");
		}

		if (cursor + responseLength > payloadBytes.length) {
			throw new Error("FC20 response sub-response overruns payload length.");
		}

		const referenceType = payloadBytes[cursor] ?? 0;
		cursor += 1;
		const dataBytes = responseLength - 1;

		if (dataBytes % 2 !== 0) {
			throw new Error("FC20 response data length must be even.");
		}

		const values: number[] = [];
		for (let offset = 0; offset < dataBytes; offset += 2) {
			const hi = payloadBytes[cursor + offset] ?? 0;
			const lo = payloadBytes[cursor + offset + 1] ?? 0;
			values.push(((hi << 8) | lo) & 0xFFFF);
		}
		cursor += dataBytes;

		const requestSegment = requestSegments[index] ?? createDefaultSegment();
		parsed.push({
			index,
			referenceType,
			fileNumber: clampWord(requestSegment.fileNumber),
			recordNumber: clampWord(requestSegment.recordNumber),
			wordCount: values.length,
			values,
		});
		index += 1;
	}

	return parsed;
}

function parseWriteResponseSegments(
	payloadBytes: number[],
	requestSegments: FileRecordSegment[],
): ParsedFileRecordSegment[] {
	if (payloadBytes.length === 0) return [];

	const byteCount = payloadBytes[0] ?? 0;
	const expectedPayloadLength = payloadBytes.length - 1;
	if (byteCount !== expectedPayloadLength) {
		throw new Error(`FC21 response byte count mismatch (header=${byteCount}, actual=${expectedPayloadLength}).`);
	}

	let cursor = 1;
	let index = 0;
	const parsed: ParsedFileRecordSegment[] = [];

	while (cursor < payloadBytes.length) {
		const referenceType = payloadBytes[cursor] ?? 0;
		const fileNumber = ((payloadBytes[cursor + 1] ?? 0) << 8) | (payloadBytes[cursor + 2] ?? 0);
		const recordNumber = ((payloadBytes[cursor + 3] ?? 0) << 8) | (payloadBytes[cursor + 4] ?? 0);
		const wordCount = ((payloadBytes[cursor + 5] ?? 0) << 8) | (payloadBytes[cursor + 6] ?? 0);
		cursor += 7;

		const values: number[] = [];
		for (let i = 0; i < wordCount; i += 1) {
			if (cursor + 1 >= payloadBytes.length) {
				throw new Error("FC21 response ended before all words were parsed.");
			}
			const value = ((payloadBytes[cursor] ?? 0) << 8) | (payloadBytes[cursor + 1] ?? 0);
			values.push(value & 0xFFFF);
			cursor += 2;
		}

		const requestSegment = requestSegments[index];
		parsed.push({
			index,
			referenceType,
			fileNumber: requestSegment ? clampWord(requestSegment.fileNumber) : (fileNumber & 0xFFFF),
			recordNumber: requestSegment ? clampWord(requestSegment.recordNumber) : (recordNumber & 0xFFFF),
			wordCount,
			values,
		});
		index += 1;
	}

	return parsed;
}

function parseExecutionResponse(
	mode: FileRecordMode,
	responseHex: string,
	requestSegments: FileRecordSegment[],
): ParsedFileRecordSegment[] {
	const payload = parseHexToBytes(responseHex);
	if (payload.length === 0) return [];
	if (mode === "read") {
		return parseReadResponseSegments(payload, requestSegments);
	}
	return parseWriteResponseSegments(payload, requestSegments);
}

function summarizeSegments(mode: FileRecordMode, segments: FileRecordSegment[]): string {
	const tags = segments.map((segment) => {
		const fileNumber = clampWord(segment.fileNumber);
		const recordNumber = clampWord(segment.recordNumber);
		const words = clampWordCount(segment.wordCount);
		return `F${fileNumber}/R${recordNumber}(${words}${mode === "write" ? "w" : "r"})`;
	});

	return `${mode.toUpperCase()} ${tags.join(", ")}`;
}

function formatFcLabel(functionCode: number): string {
	if (functionCode === 0x14) return "FC20";
	if (functionCode === 0x15) return "FC21";
	return `FC0x${functionCode.toString(16).toUpperCase()}`;
}

function loadStoredScenarios(): StoredFileRecordScenario[] {
	if (typeof sessionStorage === "undefined") return [];

	try {
		const raw = sessionStorage.getItem(FILE_RECORD_SCENARIOS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];

		return parsed
			.map((item) => {
				const value = item as Partial<StoredFileRecordScenario>;
				const mode = value.mode === "write" ? "write" : "read";
				const segments = Array.isArray(value.segments)
					? value.segments
						.map((segment) => {
							const s = segment as Partial<FileRecordSegment>;
							return {
								id: makeId("seg"),
								fileNumber: clampWord(Number(s.fileNumber)),
								recordNumber: clampWord(Number(s.recordNumber)),
								wordCount: clampWordCount(Number(s.wordCount)),
								writeValuesText: typeof s.writeValuesText === "string" ? s.writeValuesText : "0",
							};
						})
						.filter((segment) => Number.isFinite(segment.fileNumber))
					: [];

				const pollInterval = clampPollInterval(Number(value.pollInterval));
				return {
					name: typeof value.name === "string" && value.name.trim().length > 0
						? value.name.trim()
						: `Scenario ${Math.floor(Math.random() * 1000)}`,
					mode,
					pollInterval,
					segments: segments.length > 0 ? segments : [createDefaultSegment()],
				} satisfies StoredFileRecordScenario;
			})
			.slice(0, 24);
	} catch {
		return [];
	}
}

function persistScenarios(): void {
	if (typeof sessionStorage === "undefined") return;
	sessionStorage.setItem(FILE_RECORD_SCENARIOS_KEY, JSON.stringify(fileRecordState.scenarios));
}

function restartPollTimer(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}

	if (!fileRecordState.pollActive) return;

	pollTimer = setInterval(() => {
		void executeFileRecord(false);
	}, fileRecordState.pollInterval);
}

const initialScenarios = loadStoredScenarios();

export const fileRecordState = $state({
	mode: "read" as FileRecordMode,
	segments: [createDefaultSegment()] as FileRecordSegment[],
	pending: false,
	pollActive: false,
	pollInterval: clampPollInterval(getSettingsSnapshot().polling.defaultIntervalMs),
	error: "",
	warnings: [] as string[],
	lastExecution: null as FileRecordExecution | null,
	history: [] as FileRecordExecution[],
	scenarios: initialScenarios,
	selectedScenarioName: "",
});

function collectWarnings(mode: FileRecordMode, segments: FileRecordSegment[]): string[] {
	const warnings: string[] = [];
	if (segments.length === 0) {
		warnings.push("At least one segment is required.");
		return warnings;
	}

	if (mode === "read" && segments.length > 30) {
		warnings.push("Large FC20 request: many segments may be rejected by some devices.");
	}

	for (const segment of segments) {
		const words = clampWordCount(segment.wordCount);
		if (words > 120) {
			warnings.push(`Segment F${segment.fileNumber}/R${segment.recordNumber} has high word count (${words}).`);
		}
	}

	return warnings;
}

function pushHistory(execution: FileRecordExecution): void {
	fileRecordState.history = [execution, ...fileRecordState.history].slice(0, FILE_RECORD_HISTORY_LIMIT);
}

function normalizeSegmentsInPlace(): void {
	fileRecordState.segments = fileRecordState.segments.map((segment) => ({
		...segment,
		fileNumber: clampWord(segment.fileNumber),
		recordNumber: clampWord(segment.recordNumber),
		wordCount: clampWordCount(segment.wordCount),
	}));
}

export function initFileRecordState(): void {
	if (fileRecordState.segments.length === 0) {
		fileRecordState.segments = [createDefaultSegment()];
	}
	normalizeSegmentsInPlace();
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function teardownFileRecordState(): void {
	setFileRecordPollActive(false);
}

export function setFileRecordMode(mode: FileRecordMode): void {
	fileRecordState.mode = mode;
	if (mode === "write" && fileRecordState.pollActive) {
		setFileRecordPollActive(false);
		notifyWarning("Polling is available only for read mode (FC20).");
	}
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function setFileRecordPollInterval(intervalMs: number): void {
	fileRecordState.pollInterval = clampPollInterval(intervalMs);
	if (fileRecordState.pollActive) {
		restartPollTimer();
	}
}

export function setFileRecordPollActive(active: boolean): void {
	if (active && fileRecordState.mode !== "read") {
		notifyWarning("Polling supports read mode only.");
		fileRecordState.pollActive = false;
		restartPollTimer();
		return;
	}

	fileRecordState.pollActive = active;
	restartPollTimer();

	if (active) {
		void executeFileRecord(false);
	}
}

export function addFileRecordSegment(): void {
	fileRecordState.segments = [...fileRecordState.segments, createDefaultSegment()];
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function duplicateFileRecordSegment(segmentId: string): void {
	const source = fileRecordState.segments.find((segment) => segment.id === segmentId);
	if (!source) return;
	fileRecordState.segments = [...fileRecordState.segments, cloneSegment(source)];
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function removeFileRecordSegment(segmentId: string): void {
	fileRecordState.segments = fileRecordState.segments.filter((segment) => segment.id !== segmentId);
	if (fileRecordState.segments.length === 0) {
		fileRecordState.segments = [createDefaultSegment()];
	}
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function clearFileRecordSegments(): void {
	fileRecordState.segments = [createDefaultSegment()];
	fileRecordState.error = "";
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);
}

export function setFileRecordSegmentNumber(
	segmentId: string,
	field: "fileNumber" | "recordNumber" | "wordCount",
	value: number,
): void {
	const next = fileRecordState.segments.map((segment) => {
		if (segment.id !== segmentId) return segment;
		if (field === "wordCount") {
			return { ...segment, wordCount: clampWordCount(value) };
		}
		return { ...segment, [field]: clampWord(value) };
	});
	fileRecordState.segments = next;
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, next);
}

export function setFileRecordSegmentWriteValues(segmentId: string, text: string): void {
	fileRecordState.segments = fileRecordState.segments.map((segment) =>
		segment.id === segmentId ? { ...segment, writeValuesText: text } : segment,
	);
}

export function clearFileRecordResult(): void {
	fileRecordState.error = "";
	fileRecordState.lastExecution = null;
}

export function applyFileRecordExecution(executionId: string): void {
	const execution = fileRecordState.history.find((item) => item.id === executionId);
	if (!execution) return;
	fileRecordState.lastExecution = execution;
}

export function saveFileRecordScenario(name: string): void {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		notifyWarning("Scenario name cannot be empty.");
		return;
	}

	const nextScenario: StoredFileRecordScenario = {
		name: trimmed,
		mode: fileRecordState.mode,
		pollInterval: fileRecordState.pollInterval,
		segments: copySegments(fileRecordState.segments),
	};

	const others = fileRecordState.scenarios.filter((scenario) => scenario.name !== trimmed);
	fileRecordState.scenarios = [nextScenario, ...others].slice(0, 24);
	fileRecordState.selectedScenarioName = trimmed;
	persistScenarios();
	notifyInfo(`Scenario '${trimmed}' saved.`);
}

export function loadFileRecordScenario(name: string): void {
	const scenario = fileRecordState.scenarios.find((item) => item.name === name);
	if (!scenario) {
		notifyWarning(`Scenario '${name}' not found.`);
		return;
	}

	fileRecordState.mode = scenario.mode;
	fileRecordState.pollInterval = clampPollInterval(scenario.pollInterval);
	fileRecordState.segments = copySegments(scenario.segments).map((segment) => ({
		...segment,
		id: makeId("seg"),
		fileNumber: clampWord(segment.fileNumber),
		recordNumber: clampWord(segment.recordNumber),
		wordCount: clampWordCount(segment.wordCount),
	}));
	fileRecordState.selectedScenarioName = scenario.name;
	fileRecordState.error = "";
	fileRecordState.warnings = collectWarnings(fileRecordState.mode, fileRecordState.segments);

	if (fileRecordState.mode === "write" && fileRecordState.pollActive) {
		setFileRecordPollActive(false);
	}

	notifyInfo(`Scenario '${scenario.name}' loaded.`);
}

export function deleteFileRecordScenario(name: string): void {
	const before = fileRecordState.scenarios.length;
	fileRecordState.scenarios = fileRecordState.scenarios.filter((scenario) => scenario.name !== name);
	if (fileRecordState.selectedScenarioName === name) {
		fileRecordState.selectedScenarioName = "";
	}

	if (fileRecordState.scenarios.length !== before) {
		persistScenarios();
		notifyInfo(`Scenario '${name}' deleted.`);
	}
}

export function exportCurrentFileRecordScenario(): string {
	const payload = {
		schema: "modbus-lab.file-records.v1",
		scenario: {
			name: fileRecordState.selectedScenarioName || "Exported Scenario",
			mode: fileRecordState.mode,
			pollInterval: fileRecordState.pollInterval,
			segments: fileRecordState.segments.map((segment) => ({
				fileNumber: clampWord(segment.fileNumber),
				recordNumber: clampWord(segment.recordNumber),
				wordCount: clampWordCount(segment.wordCount),
				writeValuesText: segment.writeValuesText,
			})),
		},
	};

	return JSON.stringify(payload, null, 2);
}

export function importFileRecordScenarioJson(raw: string): void {
	try {
		const parsed = JSON.parse(raw) as {
			scenario?: {
				name?: string;
				mode?: FileRecordMode;
				pollInterval?: number;
				segments?: Array<Partial<FileRecordSegment>>;
			};
		};
		const scenario = parsed.scenario;
		if (!scenario) {
			throw new Error("Missing 'scenario' object.");
		}

		const mode = scenario.mode === "write" ? "write" : "read";
		const segments = (scenario.segments ?? []).map((segment) => ({
			id: makeId("seg"),
			fileNumber: clampWord(Number(segment.fileNumber)),
			recordNumber: clampWord(Number(segment.recordNumber)),
			wordCount: clampWordCount(Number(segment.wordCount)),
			writeValuesText: typeof segment.writeValuesText === "string" ? segment.writeValuesText : "0",
		}));

		fileRecordState.mode = mode;
		fileRecordState.pollInterval = clampPollInterval(Number(scenario.pollInterval));
		fileRecordState.segments = segments.length > 0 ? segments : [createDefaultSegment()];
		fileRecordState.error = "";
		fileRecordState.warnings = collectWarnings(mode, fileRecordState.segments);
		notifyInfo("Scenario imported.");
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid scenario JSON.";
		notifyError(`Import failed: ${message}`);
	}
}

async function executeFileRecordWithSegments(
	requestSegments: FileRecordSegment[],
	notifyOnSuccess: boolean,
): Promise<void> {
	if (connectionState.status !== "connected") {
		const message = "Connect to a device before running File Record operations.";
		fileRecordState.error = message;
		notifyWarning(message);
		return;
	}

	if (fileRecordState.pending) return;

	const mode = fileRecordState.mode;
	const functionCode = mode === "read" ? 0x14 : 0x15;

	fileRecordState.pending = true;
	fileRecordState.error = "";
	fileRecordState.warnings = collectWarnings(mode, requestSegments);
	const startedAt = Date.now();

	try {
		const payloadBytes = mode === "read"
			? buildReadPayload(requestSegments)
			: buildWritePayload(requestSegments);
		const payloadHex = bytesToHex(payloadBytes);
		const response = mode === "read"
			? await modbusAdapter.readFileRecords(payloadHex)
			: await modbusAdapter.writeFileRecords(payloadHex);

		const parsedSegments = parseExecutionResponse(mode, response.responseHex, requestSegments);
		const execution: FileRecordExecution = {
			id: makeId("exec"),
			mode,
			functionCode,
			requestHex: response.requestHex,
			responseHex: response.responseHex,
			requestSummary: response.requestSummary,
			responseSummary: response.responseSummary,
			startedAt,
			durationMs: Date.now() - startedAt,
			segments: requestSegments,
			parsedSegments,
		};

		fileRecordState.lastExecution = execution;
		pushHistory(execution);

		addLog(
			"info",
			`[FILE-RECORDS] ${formatFcLabel(functionCode)} ok ${summarizeSegments(mode, requestSegments)} rsp=${response.responseHex}`,
		);

		if (notifyOnSuccess) {
			notifyInfo(`${formatFcLabel(functionCode)} executed successfully.`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : parseInvokeError(err);
		fileRecordState.error = message;
		addLog("error", `[FILE-RECORDS] exec err mode=${mode} msg=${message}`);
		notifyError(`File Record failed: ${message}`);
	} finally {
		fileRecordState.pending = false;
	}
}

export async function executeFileRecordSegment(segmentId: string, notifyOnSuccess: boolean = true): Promise<void> {
	const segment = fileRecordState.segments.find((item) => item.id === segmentId);
	if (!segment) {
		notifyWarning("Segment not found.");
		return;
	}

	await executeFileRecordWithSegments(copySegments([segment]), notifyOnSuccess);
}

export async function executeFileRecord(notifyOnSuccess: boolean = true): Promise<void> {
	const requestSegments = copySegments(fileRecordState.segments);
	await executeFileRecordWithSegments(requestSegments, notifyOnSuccess);
}
