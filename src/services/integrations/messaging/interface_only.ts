/**
 * Interface-only messaging adapter factory (telegram, viber, signal).
 *
 * Per MASTER Rule 18 exception: complete Integration implementations
 * awaiting live provider contributions. send() throws
 * ProviderNotImplementedError — surfaced by the dispatcher as a structured
 * delivery failure, never a silent no-op, never a mock.
 */

import { Integration, IntegrationResult, ProviderNotImplementedError, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export function makeInterfaceOnlyMessagingAdapter(name: string): Integration<HttpProviderConfig, SmsInput, SmsOutput> {
  return {
    name,
    async send(_input: SmsInput, _config: HttpProviderConfig): Promise<IntegrationResult<SmsOutput>> {
      void _input;
      void _config;
      throw new ProviderNotImplementedError(name);
    },
    async healthCheck(_config: HttpProviderConfig): Promise<boolean> {
      void _config;
      throw new ProviderNotImplementedError(name);
    },
  };
}
