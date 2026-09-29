/**
 * Free Framework adapter (free_framework:free_framework) — INTERFACE-ONLY.
 *
 * Per MASTER Rule 18 exception: this is a complete Integration
 * implementation awaiting a live provider contribution. It is NOT a stub —
 * calling send() throws ProviderNotImplementedError, which the dispatcher
 * surfaces as a structured delivery failure (never a silent no-op, never a
 * mock). See README.md for the contract a live implementation must fulfil.
 */

import { Integration, IntegrationResult, ProviderNotImplementedError, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export const freeFrameworkAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = {
  name: "free_framework",
  async send(_input: SmsInput, _config: HttpProviderConfig): Promise<IntegrationResult<SmsOutput>> {
    void _input;
    void _config;
    throw new ProviderNotImplementedError("free_framework");
  },
  async healthCheck(_config: HttpProviderConfig): Promise<boolean> {
    void _config;
    throw new ProviderNotImplementedError("free_framework");
  },
};
