// Test-only: fill erpc-cli placeholders so the checked-in template config can be asserted.
export const renderTemplateFixture = (toml: string): string =>
  toml
    .replaceAll('{{app.name}}', 'fixture-wallet')
    .replaceAll('{{domain}}', 'wallet.example.com')
    .replaceAll('{{MCP_SERVER_BASE_URL}}', 'https://wallet.example.com')
    .replaceAll('{{OAUTH_ISSUER}}', 'https://wallet.example.com')
    .replaceAll('{{ALLOWED_GOOGLE_EMAILS}}', 'owner@example.com')
    .replaceAll('{{APP_OIDC_ISSUER}}', 'https://app-oidc-api.s-kishi.workers.dev')
    .replaceAll('{{APP_OIDC_CLIENT_ID}}', 'app_AAAAAAAAAAAAAAAAAAAAAA')
    .replaceAll('{{erpc:kv-id:MCP_KV}}', '00000000000000000000000000000000')
