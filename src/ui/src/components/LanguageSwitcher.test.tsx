import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// LanguageSwitcher/I18nProvider fetch the server dictionary via global
// fetch on mount; stub it so the test is deterministic and offline —
// it should also work if this rejects (see i18n.tsx's catch), but
// resolving here lets us assert the successful-merge path too.
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ language: "en", translations: {} }),
});
vi.stubGlobal("fetch", fetchMock);

import { I18nProvider, useI18n } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

function Harness({ onLanguageChange }: { onLanguageChange?: (lang: "en" | "bn") => void }) {
  return (
    <I18nProvider>
      <LanguageSwitcher onLanguageChange={onLanguageChange} />
    </I18nProvider>
  );
}

describe("LanguageSwitcher", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
  });

  it("renders both language options, defaulting to English active", () => {
    render(<Harness />);

    const enButton = screen.getByRole("button", { name: "English" });
    const bnButton = screen.getByRole("button", { name: "বাংলা" });
    expect(enButton).toBeInTheDocument();
    expect(bnButton).toBeInTheDocument();
    expect(enButton).toHaveAttribute("aria-pressed", "true");
    expect(bnButton).toHaveAttribute("aria-pressed", "false");
  });

  it("switches the active language when clicked and persists the choice to localStorage", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "বাংলা" }));

    expect(screen.getByRole("button", { name: "বাংলা" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("uros_ui_language")).toBe("bn");
  });

  it("invokes onLanguageChange with the newly selected language", () => {
    const onLanguageChange = vi.fn();
    render(<Harness onLanguageChange={onLanguageChange} />);

    fireEvent.click(screen.getByRole("button", { name: "বাংলা" }));

    expect(onLanguageChange).toHaveBeenCalledWith("bn");
  });

  it("does not call onLanguageChange when re-clicking the already-active language", () => {
    const onLanguageChange = vi.fn();
    render(<Harness onLanguageChange={onLanguageChange} />);

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(onLanguageChange).not.toHaveBeenCalled();
  });

  it("a component consuming useI18n().t() re-renders with translated text after switching language", () => {
    function Probe() {
      const { t } = useI18n();
      return <span>{t("portal.sendCode")}</span>;
    }

    render(
      <I18nProvider>
        <LanguageSwitcher />
        <Probe />
      </I18nProvider>
    );

    expect(screen.getByText("Send Login Code")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "বাংলা" }));

    expect(screen.getByText("লগইন কোড পাঠান")).toBeInTheDocument();
  });
});
