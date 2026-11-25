// Evita abrir janela de console do Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cyno_office_lib::run();
}
