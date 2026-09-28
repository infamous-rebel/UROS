/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  clearMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/index.ts", "!src/ui/**"],
};
