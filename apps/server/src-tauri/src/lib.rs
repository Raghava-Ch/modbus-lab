mod modbus;

use modbus::commands::{
    connect_modbus_serial_ascii, connect_modbus_serial_rtu, connect_modbus_tcp, disconnect_modbus,
    diagnostic, get_com_event_counter, get_com_event_log, get_modbus_connection_status,
    listener_clients, listener_start, listener_status, listener_stop,
    list_serial_ports, send_custom_frame,
    read_coils, read_device_identification, read_discrete_inputs, read_exception_status,
    read_holding_registers, read_input_registers, report_server_id, write_coil,
    write_coils_batch, write_holding_register, write_holding_registers_batch,
    store_write_coil, store_write_coils_batch,
    store_remove_coil, store_clear_coils, store_sync_coil_addresses,
    store_set_discrete_input, store_remove_discrete_input, store_clear_discrete_inputs,
    store_sync_discrete_input_addresses,
    store_write_holding_reg, store_remove_holding_reg, store_clear_holding_regs,
    store_sync_holding_reg_addresses,
    store_set_input_reg, store_remove_input_reg, store_clear_input_regs,
    store_sync_input_reg_addresses,
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
            list_serial_ports,
            get_modbus_connection_status,
            listener_start,
            listener_stop,
            listener_status,
            listener_clients,
            read_coils,
            read_discrete_inputs,
            read_holding_registers,
            read_input_registers,
            read_exception_status,
            diagnostic,
            send_custom_frame,
            get_com_event_counter,
            get_com_event_log,
            report_server_id,
            read_device_identification,
            write_coil,
            write_coils_batch,
            write_holding_register,
            write_holding_registers_batch,
            store_write_coil,
            store_write_coils_batch,
            store_remove_coil,
            store_clear_coils,
            store_sync_coil_addresses,
            store_set_discrete_input,
            store_remove_discrete_input,
            store_clear_discrete_inputs,
            store_sync_discrete_input_addresses,
            store_write_holding_reg,
            store_remove_holding_reg,
            store_clear_holding_regs,
            store_sync_holding_reg_addresses,
            store_set_input_reg,
            store_remove_input_reg,
            store_clear_input_regs,
            store_sync_input_reg_addresses,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
