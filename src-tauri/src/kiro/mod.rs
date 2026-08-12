//! Kiro 反代核心：把 Kiro（Amazon Q IDE）私有 API 翻译成 Anthropic Messages API。
//!
//! 移植自 https://github.com/aristra/kiro2cli（MIT License）。
//! - eventstream: AWS Event Stream 二进制帧解析
//! - auth: Kiro IDE SSO 缓存读取 + OIDC token 刷新
//! - models: 模型名映射 / effort / token 估算
//! - transform: Anthropic ↔ Kiro 请求/响应转换
//! - server: 本地 HTTP 代理（/v1/messages、/v1/models 等）
//! - integration: Tauri 命令与 Claude Code profile 接入

pub mod auth;
pub mod eventstream;
pub mod integration;
pub mod models;
pub mod server;
pub mod transform;

pub use integration::*;
