// Local quick-login configuration must not leak from .env into unrelated test processes.
process.env.DEV_QUICK_LOGIN_ENABLED = "false";
// Provider tests inject a synthetic key and mock the transport.
process.env.NVIDIA_API_KEY = "";
