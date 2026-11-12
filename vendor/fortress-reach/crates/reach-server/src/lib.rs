pub mod jsonrpc;
pub mod server;
pub mod tools;
pub mod tunnel;

pub use jsonrpc::JsonRpcHandler;
pub use server::McpServer;
pub use tools::get_mcp_tools;
pub use tunnel::TunnelManager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_lib_exports() {
        let tools = get_mcp_tools();
        assert!(!tools.is_empty());
    }
}
