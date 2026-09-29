/**
 * bdjobs Path C — Email Intake adapter (bdjobs:path_c_email_intake).
 * Fetches bdjobs application emails (CV attachments) from the org's
 * application mailbox. The bdjobs_email credential itself carries the
 * mailbox config (same format as email:imap_inbound) so no second
 * credential lookup is needed. Delegates transport to the IMAP inbound
 * adapter via the injected-client factory boundary.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import { makeImapInboundAdapter, ImapInput, ImapOutput } from "../email/imap_inbound";

const imapTransport = makeImapInboundAdapter();

export const bdjobsEmailIntakeAdapter: Integration<HttpProviderConfig, ImapInput, ImapOutput> = {
  name: "path_c_email_intake",
  async send(input: ImapInput, config: HttpProviderConfig): Promise<IntegrationResult<ImapOutput>> {
    return imapTransport.send(input, config);
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    return imapTransport.healthCheck(config);
  },
};
