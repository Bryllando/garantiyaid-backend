// Local quick-login configuration must not leak from .env into unrelated test processes.
process.env.DEV_QUICK_LOGIN_ENABLED = "false";
