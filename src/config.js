require("dotenv").config({ path: process.env.DOTENV_CONFIG_PATH || ".env.local" });
require("dotenv").config();

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

module.exports = {
  getRequiredEnv
};
