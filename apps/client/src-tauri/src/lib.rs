mod cloud_bridge;
mod ibus;
mod modbus;

use cloud_bridge::mqtt::commands::{
    get_cloud_bridge_status, start_cloud_bridge, stop_cloud_bridge,
};
use cloud_bridge::mqtt::state::CloudBridgeState;
use modbus::commands::{
    connect_modbus_serial_ascii, connect_modbus_serial_rtu, connect_modbus_tcp, disconnect_modbus,
    diagnostic, get_com_event_counter, get_com_event_log, get_modbus_connection_status,
    read_file_records,
    list_serial_ports, send_custom_frame,
    read_coils, read_device_identification, read_discrete_inputs, read_exception_status,
    read_fifo_queue,
    read_holding_registers, read_input_registers, report_server_id, write_coil,
    write_file_records,
    write_coils_batch, write_holding_register, write_holding_registers_batch,
};
use modbus::service::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .manage(CloudBridgeState::new())
        .invoke_handler(tauri::generate_handler![
            connect_modbus_tcp,
            disconnect_modbus,
            connect_modbus_serial_rtu,
            connect_modbus_serial_ascii,
            list_serial_ports,
            get_modbus_connection_status,
            read_coils,
            read_discrete_inputs,
            read_holding_registers,
            read_input_registers,
            read_fifo_queue,
            read_file_records,
            write_file_records,
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
            get_cloud_bridge_status,
            start_cloud_bridge,
            stop_cloud_bridge,
            ibus::ibus_parse_identity,
            ibus::ibus_parse_manifest,
            ibus::ibus_parse_points,
            ibus::ibus_parse_descriptor,
            ibus::ibus_decode_point,
            ibus::ibus_encode_point,
            ibus::ibus_run_conformance,
            ibus::ibus_lookup_unit,
            ibus::ibus_constants,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
