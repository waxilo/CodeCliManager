fn main() {
    // tauri_build 只对 tauri.conf.json 等发出 rerun-if-changed，不监听图标文件。
    // 显式声明 icons 目录，否则更换图标后 Windows 资源不会重新编译，
    // exe 内嵌的仍是上一次构建的旧图标。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.ico");

    tauri_build::build()
}
