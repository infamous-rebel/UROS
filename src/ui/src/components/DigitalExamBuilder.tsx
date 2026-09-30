import { useMemo, useState } from "react";
import {
  useExamList,
  useExamPaper,
  useSaveExam,
  usePublishExam,
  useParseExamPaper,
  useExamResults,
  useScoreSubmission,
  useGradeSubmission,
  downloadExamExport,
  ExamSection as ApiExamSection,
  ExamQuestion as ApiExamQuestion,
  QuestionScoreEvidence,
  DigitalExamSubmission,
} from "../hooks/hooks_exams";
import { usePersonas } from "../api/hooks_hr";
import { getToken, API_V1 } from "../api/client";
import { EmptyState } from "./EmptyState";
import { DownloadButton } from "./DownloadButton";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { ReasonCode } from "./ReasonCode";
import { useI18n } from "../i18n";

type DraftQuestion = Omit<ApiExamQuestion, "question_id" | "section_id"> & { question_id: string };
type DraftSection = Omit<ApiExamSection, "section_id" | "exam_id" | "questions"> & { section_id: string; questions: DraftQuestion[] };

let localIdCounter = 0;
const localId = () => `local-${Date.now()}-${localIdCounter++}`;

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-border-soft text-text-secondary",
  PENDING_APPROVAL: "bg-attention text-white",
  PUBLISHED: "bg-success text-white",
  ARCHIVED: "bg-text-secondary text-white",
  SUBMITTED: "bg-agent text-white",
  SCORED: "bg-success text-white",
  NEEDS_REVIEW: "bg-attention text-white",
  GRADED: "bg-success text-white",
};

function Badge({ label }: { label: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[label] ?? "bg-border-soft text-text-secondary"}`}>{label.replace("_", " ")}</span>;
}

/** "Why?" — global requirement: every result panel shows reason_code + reason_description + structured evidence, never a bare number. */
function WhyLink({ reasonCode, reasonDescription, evidenceRows }: { reasonCode: string | null; reasonDescription: string | null; evidenceRows?: Array<[string, string]> }) {
  const [open, setOpen] = useState(false);
  if (!reasonCode && !reasonDescription) return null;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="text-[11px] text-agent underline">
        Why? <Icon icon={getIcon(open ? "ChevronUp" : "ChevronDown")} size={12} tone="neutral" className="inline" />
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border-soft bg-background p-2 text-[11px]">
          {reasonCode && <ReasonCode code={reasonCode} size="sm" />}
          {reasonDescription && <div className="text-text-secondary">{reasonDescription}</div>}
          {evidenceRows && evidenceRows.length > 0 && (
            <table className="mt-1 w-full text-left">
              <tbody>
                {evidenceRows.map(([k, v]) => (
                  <tr key={k} className="border-t border-border-soft">
                    <td className="py-0.5 pr-2 text-text-secondary">{k}</td>
                    <td className="py-0.5 text-text-primary">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionEvidenceRow({ q }: { q: QuestionScoreEvidence }) {
  const { t } = useI18n();
  return (
    <div className="rounded border border-border-soft bg-surface p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-primary">{q.evidence.question_text}</span>
        <span className="text-xs font-medium text-agent">{q.marks_awarded} {t("exam.score")}</span>
      </div>
      <WhyLink
        reasonCode={q.reason_code}
        reasonDescription={q.reason_description}
        evidenceRows={[
          [t("exam.candidateAnswer"), q.evidence.submitted_answer ?? "—"],
          [t("exam.correctAnswer"), q.evidence.correct_answer ?? "—"],
          [t("exam.marksAvailable"), String(q.evidence.marks_available)],
          [t("exam.negativeMark"), String(q.evidence.negative_mark)],
          [t("exam.ruleApplied"), q.evidence.rule_applied],
        ]}
      />
    </div>
  );
}

function SubmissionRow({ examId, submission }: { examId: string; submission: DigitalExamSubmission }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const score = useScoreSubmission(examId);
  const grade = useGradeSubmission(examId);
  const [gradeReason, setGradeReason] = useState<Record<string, string>>({});
  const [gradeMarks, setGradeMarks] = useState<Record<string, number>>({});

  return (
    <div className="rounded-lg border border-border-soft bg-surface">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-primary">{submission.candidate_id ?? submission.submission_id.slice(0, 8)}</span>
          <Badge label={submission.status} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-agent">{submission.score ?? "—"}</span>
          {submission.status === "SUBMITTED" && (
            <button onClick={() => score.mutate(submission.submission_id)} className="rounded bg-agent px-2 py-1 text-[11px] font-medium text-white">
              {t("exam.score")}
            </button>
          )}
          <button onClick={() => setExpanded((e) => !e)} className="text-[11px] text-text-secondary">
            {expanded ? t("exam.hide") : t("exam.details")}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border-soft p-3">
          <WhyLink reasonCode={submission.reason_code} reasonDescription={submission.reason_description} />
          <div className="mt-2 flex flex-col gap-2">
            {(submission.score_breakdown ?? []).map((q) => (
              <div key={q.question_id}>
                <QuestionEvidenceRow q={q} />
                {q.outcome === "PENDING_MANUAL_GRADE" && (
                  <div className="mt-1 flex items-center gap-2 pl-2">
                    <input
                      type="number"
                      min={0}
                      max={q.evidence.marks_available}
                      value={gradeMarks[q.question_id] ?? 0}
                      onChange={(e) => setGradeMarks((prev) => ({ ...prev, [q.question_id]: Number(e.target.value) }))}
                      className="w-16 rounded border border-border-soft bg-background px-1 py-0.5 text-xs"
                    />
                    <input
                      value={gradeReason[q.question_id] ?? ""}
                      onChange={(e) => setGradeReason((prev) => ({ ...prev, [q.question_id]: e.target.value }))}
                      placeholder={t("exam.gradingReason")}
                      className="flex-1 rounded border border-border-soft bg-background px-1 py-0.5 text-xs"
                    />
                    <button
                      disabled={!gradeReason[q.question_id]?.trim()}
                      onClick={() =>
                        grade.mutate({
                          submissionId: submission.submission_id,
                          questionId: q.question_id,
                          marksAwarded: gradeMarks[q.question_id] ?? 0,
                          reason: gradeReason[q.question_id],
                        })
                      }
                      className="rounded bg-human px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      {t("exam.grade")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultsPanel({ examId }: { examId: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useExamResults(examId);
  if (isLoading || !data) return <EmptyState message={t("exam.loadingSubmissions")} />;
  if (data.submissions.length === 0) return <EmptyState message={t("exam.noSubmissions")} />;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-2">
          {data.status_counts.map((row) => (
            <div key={row.status} className="rounded-md border border-border-soft bg-surface px-2.5 py-1.5 text-xs">
              <span className="font-semibold text-text-primary">{row.count}</span> <span className="text-text-secondary">{row.status.replace("_", " ")}</span>
            </div>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <DownloadButton endpoint={`${API_V1}/exams/${examId}/export?format=pdf`} format="pdf" filename={`exam-${examId.slice(0, 8)}.pdf`} label={t("exam.resultsPdf")} size="sm" />
          <DownloadButton endpoint={`${API_V1}/exams/${examId}/export?format=docx`} format="docx" filename={`exam-${examId.slice(0, 8)}.docx`} label={t("exam.resultsDocx")} size="sm" />
        </div>
      </div>
      {data.submissions.map((s) => (
        <SubmissionRow key={s.submission_id} examId={examId} submission={s} />
      ))}
    </div>
  );
}

function QuestionEditor({ question, onChange, onDelete }: { question: DraftQuestion; onChange: (q: DraftQuestion) => void; onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <div className="cursor-move rounded-md border border-border-soft bg-background p-2">
      <div className="flex items-center gap-2">
        <select
          value={question.question_type}
          onChange={(e) =>
            onChange({
              ...question,
              question_type: e.target.value as "MCQ" | "SHORT_ANSWER",
              options: e.target.value === "MCQ" ? question.options ?? [{ key: "A", text: "" }, { key: "B", text: "" }] : null,
              correct_answer: null,
            })
          }
          className="rounded border border-border-soft bg-surface px-1.5 py-1 text-xs"
        >
          <option value="MCQ">{t("exam.mcq")}</option>
          <option value="SHORT_ANSWER">{t("exam.shortAnswer")}</option>
        </select>
        <input
          value={question.question_text}
          onChange={(e) => onChange({ ...question, question_text: e.target.value })}
          placeholder={t("exam.questionText")}
          className="flex-1 rounded border border-border-soft bg-surface px-2 py-1 text-xs"
        />
        <input
          type="number"
          min={0}
          value={question.marks}
          onChange={(e) => onChange({ ...question, marks: Number(e.target.value) })}
          className="w-14 rounded border border-border-soft bg-surface px-1.5 py-1 text-xs"
          title={t("exam.marks")}
        />
        <input
          type="number"
          min={0}
          value={question.negative_mark}
          onChange={(e) => onChange({ ...question, negative_mark: Number(e.target.value) })}
          className="w-14 rounded border border-border-soft bg-surface px-1.5 py-1 text-xs"
          title={t("exam.negativeMark")}
        />
        {question.source !== "MANUAL" && <span className="text-[10px] text-text-secondary">{question.source}</span>}
        <button onClick={onDelete} className="text-xs text-danger">
          <Icon icon={getIcon("X")} size={14} tone="neutral" />
        </button>
      </div>
      {question.question_type === "MCQ" && (
        <div className="mt-1 flex flex-col gap-1 pl-6">
          {(question.options ?? []).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 text-xs text-text-secondary">{opt.key}</span>
              <input
                value={opt.text}
                onChange={(e) => {
                  const options = [...(question.options ?? [])];
                  options[i] = { ...opt, text: e.target.value };
                  onChange({ ...question, options });
                }}
                className="flex-1 rounded border border-border-soft bg-surface px-2 py-0.5 text-xs"
              />
              <input
                type="radio"
                name={`correct-${question.question_id}`}
                checked={question.correct_answer === opt.key}
                onChange={() => onChange({ ...question, correct_answer: opt.key })}
                title={t("exam.markCorrect")}
              />
            </div>
          ))}
          <button
            onClick={() => {
              const nextKey = String.fromCharCode(65 + (question.options?.length ?? 0));
              onChange({ ...question, options: [...(question.options ?? []), { key: nextKey, text: "" }] });
            }}
            className="w-fit text-[11px] text-agent underline"
          >
            {t("exam.addOption")}
          </button>
        </div>
      )}
    </div>
  );
}

export function DigitalExamBuilder() {
  const { t } = useI18n();
  const { data: examListData } = useExamList();
  const { data: personasData } = usePersonas();
  const [activeExamId, setActiveExamId] = useState<string | null>(null);
  const { data: paperData } = useExamPaper(activeExamId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | "">("");
  const [personaId, setPersonaId] = useState("");
  const [sections, setSections] = useState<DraftSection[]>([]);
  const [dragSection, setDragSection] = useState<string | null>(null);
  const [dragQuestion, setDragQuestion] = useState<{ sectionId: string; questionId: string } | null>(null);

  const save = useSaveExam();
  const publish = usePublishExam();
  const parse = useParseExamPaper();

  const totalMarks = useMemo(() => sections.reduce((s, sec) => s + sec.questions.reduce((qs, q) => qs + q.marks, 0), 0), [sections]);

  const loadExam = (id: string) => {
    setActiveExamId(id);
  };

  // Sync loaded paper into editable draft state once fetched.
  useMemo(() => {
    if (paperData?.paper) {
      const p = paperData.paper;
      setTitle(p.exam.title);
      setDescription(p.exam.description ?? "");
      setDurationMinutes(p.exam.duration_minutes ?? "");
      setPersonaId(p.exam.persona_id ?? "");
      setSections(
        p.sections.map((s) => ({
          section_id: s.section_id,
          section_name: s.section_name,
          order_index: s.order_index,
          topic: s.topic,
          weight: s.weight,
          questions: s.questions.map((q) => ({ ...q, question_id: q.question_id })),
        }))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperData]);

  const addSection = () => {
    setSections((prev) => [
      ...prev,
      { section_id: localId(), section_name: "New Section", order_index: prev.length + 1, topic: null, weight: null, questions: [] },
    ]);
  };

  const addQuestion = (sectionId: string) => {
    setSections((prev) =>
      prev.map((s) =>
        s.section_id === sectionId
          ? {
              ...s,
              questions: [
                ...s.questions,
                {
                  question_id: localId(),
                  question_type: "MCQ",
                  question_text: "",
                  options: [{ key: "A", text: "" }, { key: "B", text: "" }],
                  correct_answer: null,
                  marks: 1,
                  negative_mark: 0,
                  order_index: s.questions.length + 1,
                  source: "MANUAL",
                  bank_question_id: null,
                },
              ],
            }
          : s
      )
    );
  };

  const reorderSections = (fromId: string, toId: string) => {
    setSections((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((s) => s.section_id === fromId);
      const toIdx = arr.findIndex((s) => s.section_id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr.map((s, i) => ({ ...s, order_index: i + 1 }));
    });
  };

  const reorderQuestions = (sectionId: string, fromId: string, toId: string) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.section_id !== sectionId) return s;
        const arr = [...s.questions];
        const fromIdx = arr.findIndex((q) => q.question_id === fromId);
        const toIdx = arr.findIndex((q) => q.question_id === toId);
        if (fromIdx === -1 || toIdx === -1) return s;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        return { ...s, questions: arr.map((q, i) => ({ ...q, order_index: i + 1 })) };
      })
    );
  };

  const handleSave = () => {
    save.mutate(
      {
        exam_id: activeExamId ?? undefined,
        title,
        description: description || undefined,
        duration_minutes: durationMinutes || undefined,
        persona_id: personaId || undefined,
        sections: sections.map((s) => ({
          section_name: s.section_name,
          order_index: s.order_index,
          topic: s.topic ?? undefined,
          weight: s.weight ?? undefined,
          questions: s.questions.map((q) => ({
            question_type: q.question_type,
            question_text: q.question_text,
            options: q.options ?? undefined,
            correct_answer: q.correct_answer ?? undefined,
            marks: q.marks,
            negative_mark: q.negative_mark,
            order_index: q.order_index,
            source: q.source,
            bank_question_id: q.bank_question_id ?? undefined,
          })),
        })),
      },
      { onSuccess: (data) => setActiveExamId(data.exam.exam_id) }
    );
  };

  const handleParseFile = async (file: File) => {
    const result = await parse.mutateAsync(file);
    if (result.drafts.length > 0) {
      const importedSection: DraftSection = {
        section_id: localId(),
        section_name: "Imported Questions",
        order_index: sections.length + 1,
        topic: null,
        weight: null,
        questions: result.drafts.map((d) => ({
          question_id: localId(),
          question_type: d.question_type,
          question_text: d.question_text,
          options: d.options,
          correct_answer: d.correct_answer,
          marks: 1,
          negative_mark: 0,
          order_index: 0,
          source: "PARSED",
          bank_question_id: null,
        })),
      };
      setSections((prev) => [...prev, importedSection]);
    }
  };

  if (!getToken()) return <EmptyState message={t("exam.tokenRequired")} />;

  return (
    <div className="flex flex-col gap-4">
      {/* Guided step 1: pick an existing exam or start a new one */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={activeExamId ?? ""}
          onChange={(e) => (e.target.value ? loadExam(e.target.value) : setActiveExamId(null))}
          className="rounded-md border border-border-soft bg-surface px-2 py-1.5 text-xs"
        >
          <option value="">{t("exam.newExam")}</option>
          {(examListData?.exams ?? []).map((e) => (
            <option key={e.exam_id} value={e.exam_id}>
              {e.title} ({e.status})
            </option>
          ))}
        </select>
        {paperData?.paper && <Badge label={paperData.paper.exam.status} />}
        <label className="cursor-pointer rounded-md border border-border-soft px-2.5 py-1.5 text-xs text-text-secondary">
          {t("exam.uploadParse")}
          <input
            type="file"
            accept=".docx,.jpg,.jpeg,.png,.txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleParseFile(file);
              e.target.value = "";
            }}
          />
        </label>
        {parse.isPending && <span className="text-xs text-text-secondary">{t("exam.parsing")}</span>}
        {activeExamId && (
          <div className="ml-auto flex gap-2">
            <DownloadButton endpoint={`${API_V1}/exams/${activeExamId}/export?format=pdf`} format="pdf" filename="exam-paper.pdf" label={t("exam.paperPdf")} size="sm" />
            <DownloadButton endpoint={`${API_V1}/exams/${activeExamId}/export?format=docx`} format="docx" filename="exam-paper.docx" label={t("exam.paperDocx")} size="sm" />
          </div>
        )}
      </div>
      {parse.data?.error && <EmptyState message={parse.data.error} tone="danger" />}

      {/* Guided step 2-3: persona + metadata (topics/weights live on each section below) */}
      <div className="grid grid-cols-1 gap-2 rounded-lg border border-border-soft bg-surface p-3 sm:grid-cols-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("exam.titlePlaceholder")} className="rounded border border-border-soft bg-background px-2 py-1.5 text-sm" />
        <select value={personaId} onChange={(e) => setPersonaId(e.target.value)} className="rounded border border-border-soft bg-background px-2 py-1.5 text-sm">
          <option value="">{t("exam.personaPlaceholder")}</option>
          {(personasData?.personas ?? []).map((p: any) => (
            <option key={p.persona_id} value={p.persona_id}>
              {p.name}
            </option>
          ))}
        </select>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("exam.descPlaceholder")} className="rounded border border-border-soft bg-background px-2 py-1.5 text-sm sm:col-span-2" />
        <input
          type="number"
          min={1}
          value={durationMinutes}
          onChange={(e) => setDurationMinutes(e.target.value ? Number(e.target.value) : "")}
          placeholder={t("exam.durationPlaceholder")}
          className="rounded border border-border-soft bg-background px-2 py-1.5 text-sm"
        />
        <div className="flex items-center text-sm text-text-secondary">
          {t("exam.totalMarks")}: <span className="ml-1 font-medium text-agent">{totalMarks}</span>
        </div>
      </div>

      {/* Section management with drag-and-drop reordering */}
      <div className="flex flex-col gap-3">
        {sections.map((section) => (
          <div
            key={section.section_id}
            draggable
            onDragStart={() => setDragSection(section.section_id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragSection) reorderSections(dragSection, section.section_id);
              setDragSection(null);
            }}
            className="rounded-lg border border-border-soft bg-surface p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="cursor-move text-text-secondary">⠿</span>
              <input
                value={section.section_name}
                onChange={(e) => setSections((prev) => prev.map((s) => (s.section_id === section.section_id ? { ...s, section_name: e.target.value } : s)))}
                className="flex-1 rounded border border-border-soft bg-background px-2 py-1 text-sm font-medium"
              />
              <input
                value={section.topic ?? ""}
                onChange={(e) => setSections((prev) => prev.map((s) => (s.section_id === section.section_id ? { ...s, topic: e.target.value } : s)))}
                placeholder={t("exam.topic")}
                className="w-32 rounded border border-border-soft bg-background px-2 py-1 text-xs"
              />
              <input
                type="number"
                min={0}
                max={100}
                value={section.weight ?? ""}
                onChange={(e) =>
                  setSections((prev) => prev.map((s) => (s.section_id === section.section_id ? { ...s, weight: e.target.value ? Number(e.target.value) : null } : s)))
                }
                placeholder={t("exam.weightPct")}
                className="w-20 rounded border border-border-soft bg-background px-2 py-1 text-xs"
              />
              <button onClick={() => setSections((prev) => prev.filter((s) => s.section_id !== section.section_id))} className="text-xs text-danger">
                {t("exam.removeSection")}
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {section.questions.map((q) => (
                <div
                  key={q.question_id}
                  draggable
                  onDragStart={() => setDragQuestion({ sectionId: section.section_id, questionId: q.question_id })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragQuestion && dragQuestion.sectionId === section.section_id) {
                      reorderQuestions(section.section_id, dragQuestion.questionId, q.question_id);
                    }
                    setDragQuestion(null);
                  }}
                >
                  <QuestionEditor
                    question={q}
                    onChange={(updated) =>
                      setSections((prev) =>
                        prev.map((s) =>
                          s.section_id === section.section_id ? { ...s, questions: s.questions.map((qq) => (qq.question_id === q.question_id ? updated : qq)) } : s
                        )
                      )
                    }
                    onDelete={() =>
                      setSections((prev) => prev.map((s) => (s.section_id === section.section_id ? { ...s, questions: s.questions.filter((qq) => qq.question_id !== q.question_id) } : s)))
                    }
                  />
                </div>
              ))}
            </div>
            <button onClick={() => addQuestion(section.section_id)} className="mt-2 text-xs text-agent underline">
              {t("exam.addQuestion")}
            </button>
          </div>
        ))}
        <button onClick={addSection} className="rounded-md border border-dashed border-border-soft py-2 text-xs text-text-secondary">
          {t("exam.addSection")}
        </button>
      </div>

      {/* Live preview */}
      {sections.length > 0 && (
        <div className="rounded-lg border border-border-soft bg-background p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t("exam.livePreview")}</div>
          <div className="text-lg font-semibold text-text-primary">{title || t("exam.untitled")}</div>
          {description && <div className="text-sm text-text-secondary">{description}</div>}
          {sections.map((s) => (
            <div key={s.section_id} className="mt-3">
              <div className="text-sm font-medium text-text-primary underline">{s.section_name}</div>
              {s.questions.map((q, i) => (
                <div key={q.question_id} className="mt-1 text-xs text-text-secondary">
                  {i + 1}. {q.question_text || t("exam.untitledQ")} [{q.marks} {t("exam.marks")}]
                  {q.question_type === "MCQ" &&
                    (q.options ?? []).map((o) => (
                      <div key={o.key} className="pl-4">
                        {o.key}. {o.text}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Actions: save, publish (human approval gate), export */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={handleSave} disabled={save.isPending || !title || sections.length === 0} className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {save.isPending ? t("exam.saving") : activeExamId ? t("exam.saveChanges") : t("exam.createExam")}
        </button>
        {activeExamId && paperData?.paper.exam.status !== "PUBLISHED" && (
          <button onClick={() => publish.mutate(activeExamId)} disabled={publish.isPending} className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            {publish.isPending ? t("exam.publishing") : t("exam.publishApprove")}
          </button>
        )}
        {activeExamId && (
          <>
            <button onClick={() => downloadExamExport(activeExamId, "pdf")} className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary">
              {t("exam.exportPdf")}
            </button>
            <button onClick={() => downloadExamExport(activeExamId, "docx")} className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary">
              {t("exam.exportDocx")}
            </button>
            <button onClick={() => downloadExamExport(activeExamId, "interactive_pdf")} className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary">
              {t("exam.exportInteractive")}
            </button>
            <button
              onClick={async () => {
                const { link } = await downloadExamExport(activeExamId, "link");
                if (link) navigator.clipboard?.writeText(link).catch(() => undefined);
              }}
              className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary"
            >
              {t("exam.copyLink")}
            </button>
          </>
        )}
      </div>
      {save.isError && <EmptyState message={(save.error as Error)?.message ?? t("exam.saveFailed")} tone="danger" />}

      {/* Results — every result carries reason_code/reason_description/evidence via the "Why?" link */}
      {activeExamId && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-text-primary">{t("exam.submissions")}</div>
          <ResultsPanel examId={activeExamId} />
        </div>
      )}
    </div>
  );
}
