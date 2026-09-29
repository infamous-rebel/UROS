/**
 * Quest 04 — Adapter registry integrity.
 *
 * CONNECTOR_TO_ADAPTER is the single source of truth for "which adapter
 * handles which DB connector name". A mapping without a registered
 * adapter is a Rule 1 orphan (dispatch would fail at runtime), so this
 * suite proves the registry is complete, the count is exactly 31, and
 * registration is idempotent across multiple boot entrypoints.
 */
import * as fs from "fs";
import * as path from "path";
import {
  CONNECTOR_TO_ADAPTER,
  clearRegistry,
  listAllProviders,
  listConnectorNames,
  registerProvider,
  getProvider,
  resolveConnectorName,
} from "../../../src/services/integrations/_base/registry";
import { registerAllProviders } from "../../../src/services/integrations/register_all";
import { Integration } from "../../../src/services/integrations/_base/types";

const EXPECTED_ADAPTER_COUNT = 31;

const INTERFACE_ONLY_CONNECTORS = ["free_sms", "messaging_telegram", "messaging_viber", "messaging_signal"];

describe("adapter registry integrity (Quest 04)", () => {
  beforeEach(() => {
    clearRegistry();
    registerAllProviders();
  });

  it("registers exactly 31 adapters", () => {
    expect(listAllProviders()).toHaveLength(EXPECTED_ADAPTER_COUNT);
  });

  it("every CONNECTOR_TO_ADAPTER mapping resolves to a registered adapter", () => {
    const registered = listAllProviders();
    for (const [connector, mapping] of Object.entries(CONNECTOR_TO_ADAPTER)) {
      const hit = registered.some(
        (r) => r.category === mapping.category && r.provider === mapping.provider
      );
      expect({ connector, hit }).toEqual({ connector, hit: true });
      expect(getProvider(mapping.category, mapping.provider)).not.toBeNull();
    }
  });

  it("every adapter category uses a uniform Integration shape (name/send/healthCheck)", () => {
    for (const mapping of Object.values(CONNECTOR_TO_ADAPTER)) {
      const adapter = getProvider(mapping.category, mapping.provider) as Integration<any, any, any> | null;
      expect(adapter).not.toBeNull();
      expect(typeof adapter!.name).toBe("string");
      expect(typeof adapter!.send).toBe("function");
      expect(typeof adapter!.healthCheck).toBe("function");
    }
  });

  it("registration is idempotent — calling registerAllProviders twice does not duplicate", () => {
    registerAllProviders();
    expect(listAllProviders()).toHaveLength(EXPECTED_ADAPTER_COUNT);
  });

  it("clearRegistry + registerAllProviders rebuilds the full set", () => {
    clearRegistry();
    expect(listAllProviders()).toHaveLength(0);
    registerAllProviders();
    expect(listAllProviders()).toHaveLength(EXPECTED_ADAPTER_COUNT);
  });

  it("resolveConnectorName round-trips every connector name", () => {
    for (const connector of listConnectorNames()) {
      expect(resolveConnectorName(connector)).toEqual(CONNECTOR_TO_ADAPTER[connector]);
    }
    expect(resolveConnectorName("not_a_connector")).toBeNull();
  });

  it("interface-only connectors have a registry mapping (Rule 18 exception preconditions)", () => {
    for (const connector of INTERFACE_ONLY_CONNECTORS) {
      expect(resolveConnectorName(connector)).not.toBeNull();
    }
  });

  it("interface-only adapter families ship their Rule 18 README", () => {
    const base = path.resolve(__dirname, "../../../src/services/integrations");
    expect(fs.existsSync(path.join(base, "free_framework", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(base, "messaging", "README.md"))).toBe(true);
  });

  it("registerProvider overwrites a previous registration for the same (category, provider)", () => {
    const sentinel: Integration<any, any, any> = {
      name: "sentinel",
      send: async () => ({ status: "SENT" }),
      healthCheck: async () => true,
    };
    registerProvider("sms", "teletalk", sentinel);
    expect(getProvider("sms", "teletalk")!.name).toBe("sentinel");
    expect(listAllProviders()).toHaveLength(EXPECTED_ADAPTER_COUNT);
  });
});
