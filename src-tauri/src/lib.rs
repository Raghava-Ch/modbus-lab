mod modbus;

use modbus::commands::{
    connect_modbus_serial_ascii, connect_modbus_serial_rtu, connect_modbus_tcp, disconnect_modbus,
    get_modbus_connection_status, read_coils, read_discrete_inputs, read_holding_registers,
    read_input_registers, write_coil, write_coils_batch, write_holding_register,
    write_holding_registers_batch,
};
use modbus::service::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect_modbus_tcp,
            disconnect_modbus,
            connect_modbus_serial_rtu,
            connect_modbus_serial_ascii,
            get_modbus_connection_status,
            read_coils,
            read_discrete_inputs,
            read_holding_registers,
            read_input_registers,
            write_coil,
            write_coils_batch,
            write_holding_register,
            write_holding_registers_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
