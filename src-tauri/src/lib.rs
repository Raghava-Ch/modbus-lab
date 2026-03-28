mod modbus;

use modbus::commands::{
    connect_modbus_serial_ascii, connect_modbus_serial_rtu, connect_modbus_tcp, disconnect_modbus,
    get_modbus_connection_status, read_coils, write_coil, write_coils_batch,
};
use modbus::service::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect_modbus_tcp,
            disconnect_modbus,
            connect_modbus_serial_rtu,
            connect_modbus_serial_ascii,
            get_modbus_connection_status,
            read_coils,
            write_coil,
            write_coils_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
