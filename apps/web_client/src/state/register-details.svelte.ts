export type RegisterDetailsKind = "holding" | "input";

export const registerDetailsState = $state({
  kind: null as RegisterDetailsKind | null,
  address: null as number | null,
});

export function selectRegisterDetails(kind: RegisterDetailsKind, address: number): void {
  registerDetailsState.kind = kind;
  registerDetailsState.address = address;
}

export function clearRegisterDetails(): void {
  registerDetailsState.kind = null;
  registerDetailsState.address = null;
}
