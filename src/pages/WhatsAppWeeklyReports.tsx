import { useRef, useState } from "react";
import { FlaskConical, Sparkles, Zap } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const toneOptions = [
  "Formal & Professional",
  "Friendly & Conversational",
  "Bold & Promotional",
];

const languageOptions = ["English", "Hindi", "Telugu"];
const buttonTypes = ["Quick Reply", "Website", "Phone"];

export default function WhatsAppWeeklyReports() {
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState(toneOptions[0]);
  const [language, setLanguage] = useState(languageOptions[0]);
  const [selectedButtons, setSelectedButtons] = useState<string[]>(["Quick Reply"]);
  const [imageNames, setImageNames] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const toggleButtonType = (value: string) => {
    setSelectedButtons((current) => {
      if (current.includes(value)) {
        return current.filter((item) => item !== value);
      }
      if (current.length >= 2) return current;
      return [...current, value];
    });
  };

  const handleFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    setImageNames(files.slice(0, 10).map((file) => file.name));
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 text-[#1f2635]">
        <div>
          <h1 className="text-[2rem] font-bold tracking-tight">Weekly Reports</h1>
          <p className="mt-2 max-w-5xl text-[15px] leading-7 text-[#5f697c]">
            Review weekly growth, campaign delivery trends, template usage, and message performance summaries.
          </p>
        </div>

        <div className="grid gap-7 xl:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
        <section className="rounded-[28px] border border-[#e8ebf2] bg-white p-8 shadow-[0_12px_35px_rgba(15,23,42,0.06)]">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 fill-[#171717] text-[#171717]" />
              <h2 className="text-[16px] font-bold tracking-tight text-[#1f2635]">AI Config</h2>
            </div>

            <Button className="h-12 rounded-full bg-[#9da7ff] px-6 text-[14px] font-semibold text-white shadow-none hover:bg-[#909af8]">
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              Try Advanced?
            </Button>
          </div>

          <div className="mt-8 space-y-7">
            <div>
              <div className="mb-3 flex items-start justify-between gap-4">
                <label className="max-w-[210px] text-[13px] font-semibold uppercase leading-6 tracking-[0.08em] text-[#3f495d]">
                  Photos (minimum 2 required) *
                </label>
                <span className="pt-1 text-right text-[13px] font-medium leading-5 text-[#5b7cff]">
                  Max 10
                  <br />
                  images
                </span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFiles}
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-[90px] w-full items-center justify-center rounded-[22px] border-[3px] border-dashed border-[#d6dbe6] bg-white text-[15px] font-medium text-[#6a7385] transition-colors hover:border-[#bbbfd1]"
              >
                Click to Add Images
              </button>

              {imageNames.length ? (
                <p className="mt-3 text-[13px] text-[#6a7385]">{imageNames.join(", ")}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="weekly-report-prompt" className="mb-3 block text-[13px] font-semibold uppercase tracking-[0.06em] text-[#3f495d]">
                Prompt / Details *
              </label>
              <Textarea
                id="weekly-report-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="E.g., Summarize the site progress for the first week of October. Highlight the new foundation being laid."
                className="min-h-[160px] rounded-[18px] border-[#d6dbe6] px-5 py-4 text-[14px] leading-8 text-[#1f2635] placeholder:text-[#a1a8b7] focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-3 block text-[13px] font-semibold uppercase tracking-[0.06em] text-[#3f495d]">
                  Tone
                </label>
                <select
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  className="h-[56px] w-full rounded-[16px] border border-[#d6dbe6] bg-white px-5 text-[14px] font-medium text-[#1f2635] outline-none"
                >
                  {toneOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-3 block text-[13px] font-semibold uppercase tracking-[0.06em] text-[#3f495d]">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="h-[56px] w-full rounded-[16px] border border-[#d6dbe6] bg-white px-5 text-[14px] font-medium text-[#1f2635] outline-none"
                >
                  {languageOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-3 block text-[13px] font-semibold uppercase tracking-[0.06em] text-[#8e95a5]">
                Button Types (max 2 buttons) *
              </label>
              <div className="flex flex-wrap gap-3">
                {buttonTypes.map((type) => {
                  const active = selectedButtons.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleButtonType(type)}
                      className={[
                        "rounded-[14px] border px-5 py-3 text-[14px] font-semibold transition-colors",
                        active
                          ? "border-[#171717] bg-[linear-gradient(135deg,#171717,#171717)] text-white shadow-[0_8px_22px_rgba(23,23,23,0.18)]"
                          : "border-[#d6dbe6] bg-white text-[#3f495d]",
                      ].join(" ")}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>

            <Button className="h-[64px] w-full rounded-[18px] bg-[linear-gradient(135deg,#171717,#171717)] text-[16px] font-bold text-white shadow-none hover:bg-[linear-gradient(135deg,#171717,#171717)]">
              Generate Weekly Report
            </Button>
          </div>
        </section>

        <section className="rounded-[28px] border-[3px] border-dashed border-[#e3e7ee] bg-[#fbfcfe] p-8">
          <div className="flex h-full min-h-[860px] flex-col items-center justify-center text-center">
            <div className="flex h-[76px] w-[76px] items-center justify-center rounded-full bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
              <FlaskConical className="h-9 w-9 text-[#d4d9e4]" />
            </div>
            <h2 className="mt-8 text-[20px] font-bold tracking-tight text-[#1f2635]">Report Preview</h2>
            <p className="mt-5 max-w-[580px] text-[15px] leading-8 text-[#6b7280]">
              Upload images and enter a prompt on the left to generate an AI-powered WhatsApp Carousel Weekly Report.
            </p>
          </div>
        </section>
        </div>
      </div>
    </DashboardLayout>
  );
}
