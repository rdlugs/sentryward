import { generateKeyPairSync } from "node:crypto";
import { configDefaults, defineConfig } from "vitest/config";

// A throwaway GitHub App so the installation flow is testable; every forge call
// is stubbed, so this key never signs anything GitHub sees.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    // Eval cases are code under review, not tests, even when they hold tests.
    exclude: [...configDefaults.exclude, "evals/cases/**"],
    env: {
      GITHUB_HOST: "github.com",
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "sentryward-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      API_PUBLIC_URL: "https://sentryward.example.com",
      // A self-hosted GitLab OAuth app; token exchanges are stubbed like every forge call.
      GITLAB_OAUTH_HOST: "gitlab.acme.com",
      GITLAB_OAUTH_CLIENT_ID: "gitlab-client-id",
      GITLAB_OAUTH_CLIENT_SECRET: "gitlab-client-secret",
      // Sign-in providers, one on a self-managed GitLab; provider calls are stubbed.
      GITHUB_LOGIN_HOST: "github.com",
      GITHUB_LOGIN_CLIENT_ID: "github-login-id",
      GITHUB_LOGIN_CLIENT_SECRET: "github-login-secret",
      GITLAB_LOGIN_HOST: "gitlab.acme.com",
      GITLAB_LOGIN_CLIENT_ID: "gitlab-login-id",
      GITLAB_LOGIN_CLIENT_SECRET: "gitlab-login-secret",
    },
  },
});
