/**
 * Quest 04 — Communication template bodies.
 *
 * Bodies are human-authored data (no runtime inference): every registered
 * template code must have both an `en` and a `bn` body, interpolation is
 * a strict replace of known keys, unknown keys stay verbatim (and are
 * visible — never silently blanked), and unregistered codes fail loudly.
 */
import { renderTemplateBody, listAuthoredTemplates, CommunicationTemplateCode } from "../../../src/services/communication/template_bodies";

const EXPECTED_CODES: CommunicationTemplateCode[] = [
  "APPLICATION_RECEIVED",
  "SHORTLISTED",
  "REJECTION",
  "INTERVIEW_SCHEDULE",
  "FINAL_SELECTION",
  "APPLICANT_PORTAL_OTP",
  "REDISCOVERY_INVITE",
  "PASSWORD_RESET_LINK",
];

const PARAMS = {
  candidate_name: "Nusrat Jahan",
  candidate_id: "CAND-42",
  org_name: "DPE",
  position: "Assistant Teacher",
  interview_time: "Sunday 10am",
  location: "Dhaka HQ",
  otp: "123456",
};

describe("template bodies coverage", () => {
  it("every expected template code has an authored body (en + bn)", () => {
    expect(listAuthoredTemplates().sort()).toEqual([...EXPECTED_CODES].sort());
    for (const code of EXPECTED_CODES) {
      for (const language of ["en", "bn"] as const) {
        const body = renderTemplateBody(code, language, PARAMS);
        expect(body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("no body contains an uninterpolated known placeholder after rendering", () => {
    for (const code of EXPECTED_CODES) {
      for (const language of ["en", "bn"] as const) {
        const body = renderTemplateBody(code, language, PARAMS);
        expect(body).not.toMatch(/\{\{candidate_name\}\}/);
        expect(body).not.toMatch(/\{\{org_name\}\}/);
        expect(body).not.toMatch(/\{\{position\}\}/);
      }
    }
  });

  it("interpolates parameters into the en body", () => {
    const body = renderTemplateBody("APPLICATION_RECEIVED", "en", PARAMS);
    expect(body).toContain("Dear Nusrat Jahan");
    expect(body).toContain("for Assistant Teacher at DPE");
    expect(body).toContain("Reference: CAND-42");
  });

  it("renders the authored Bengali body", () => {
    const body = renderTemplateBody("APPLICATION_RECEIVED", "bn", PARAMS);
    expect(body).toContain("প্রিয় Nusrat Jahan");
    expect(body).toContain("রেফারেন্স: CAND-42");
  });

  it("unknown keys remain verbatim — visible, never silently blanked", () => {
    const body = renderTemplateBody("SHORTLISTED", "en", { candidate_name: "Rafiq" });
    expect(body).toContain("Dear Rafiq");
    expect(body).toContain("{{org_name}}");
    expect(body).toContain("{{position}}");
  });

  it("renders an unparameterised OTP template with only the otp key supplied", () => {
    const body = renderTemplateBody("APPLICANT_PORTAL_OTP", "en", { otp: "998877" });
    expect(body).toContain("998877");
    expect(body).not.toContain("{{otp}}");
  });

  it("unregistered template codes fail loudly with authoring guidance", () => {
    expect(() => renderTemplateBody("NOT_AUTHORED", "en", PARAMS)).toThrow(/no authored body.*template_bodies/);
  });
});
