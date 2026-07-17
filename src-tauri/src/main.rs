// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if focus_pet_lib::maybe_handle_agent_notification() {
        return;
    }
    focus_pet_lib::run();
}
