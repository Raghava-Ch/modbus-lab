# ModBux

ModBux is a desktop Modbus master client built with Svelte + Tauri.
It is focused on practical day-to-day register/coil operations with a fast UI, rich polling controls, and detailed operation logs.

## Project Status

Current status: usable for core Modbus workflows.

Implemented and working:
- Connection management (Modbus TCP UI + protocol selector shell for TCP/RTU/ASCII)
- Coils (FC01 read, FC05 single write, FC15 batch write)
- Discrete Inputs (FC02 read)
- Holding Registers (FC03 read, FC06 single write, FC16 batch write)
- Input Registers (FC04 read)
- Global settings (poll defaults, display format, forced layout, log preferences)
- App log panel with filtering and native save-to-file export

Not implemented yet (currently placeholder pages):
- File Records (FC20/FC21)
- FIFO Queue (FC24)
- Diagnostics (FC08)

## Feature Summary

### Connection
- Connection page with protocol cards and TCP settings
- Connected/disconnected state badges in header
- Device context chips (protocol, endpoint, slave id)

### Coils (FC01/FC05/FC15)
- Table and switch-card views
- Single read/write actions
- Batch write for pending desired values
- Polling with interval control and limits
- Range add + single custom address add

### Discrete Inputs (FC02)
- Read-only table view
- Polling support
- Address range and custom address add

### Holding Registers (FC03/FC06/FC16)
- Table and card views
- Read value vs desired value editing
- Single write and pending batch write
- Address filtering (range/list include/exclude)
- Polling with practical interval handling

### Input Registers (FC04)
- Read-only table and card views
- Address filtering (range/list include/exclude)
- Polling with chunked section planning

### Logging
- Live log panel with level filters: `ALL`, `TRAFFIC`, `INFO`, `WARN`, `ERROR`
- Scheduling/plan logs for grouped reads and writes
- Native desktop export with save dialog
- Retention control via settings

### Settings
- Default polling interval
- Maximum address count allowed for polling
- Address/value display format: decimal or hex
- Forced layout: auto, desktop, mobile
- Log time format and precision
- Per-feature defaults (view/start/count)

## Screenshots

### Connection
![Connection Settings](screenshots/ConnectionSettings.png)

### Coils
![Coils - Switch View](screenshots/CoilsSwitchView.png)
![Coils - Table View](screenshots/CoilsTableView.png)

### Discrete Inputs
![Discrete Inputs - Table View](screenshots/DiscreteInputsTableView.png)

### Holding Registers
![Holding Registers - Switch View](screenshots/HoldingRegistersSwitchView.png)
![Holding Registers - Table View](screenshots/HoldingRegistersTableView.png)

### Input Registers
![Input Registers - Table View](screenshots/InputRegistersTableView.png)

## Log Examples

Representative runtime logs from current implementation:

```text
INFO  ModBux shell initialized.
INFO  [CONNECTION] connect.tcp start host=192.168.55.200 port=502
INFO  [CONNECTION] connect.tcp ok | status=connectedTcp (TCP 192.168.55.200:502)
INFO  fc01.read plan total=16 sections=1 ops=1 sample=[0..15]
INFO  fc01.read ok total=16 ok=16 sections=1
INFO  fc03.read plan total=16 sections=1 ops=1 chunkMax=125 sample=[0..15]
INFO  fc03.read ok total=16 ok=16 sections=1
ERROR fc04.read err addr=15 msg=Read input registers failed.
```

## Tech Stack

- Frontend: Svelte 5 + TypeScript + Vite
- Desktop runtime: Tauri v2
- Icons/bundling: Tauri icon/bundle pipeline

## Local Development

### Prerequisites
- Node.js 20+
- Rust toolchain + Cargo
- Tauri v2 prerequisites for your OS

### Install
```bash
npm install
```

### Run web dev server
```bash
npm run dev
```

### Run desktop app (Tauri)
```bash
npm run tauri dev
```

### Type check
```bash
npm run check
```

### Production build
```bash
npm run tauri build
```

## License

See [LICENSE](LICENSE).
