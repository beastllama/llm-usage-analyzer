import { GoogleGenAI } from "@google/genai";
import { UsageReport } from "../types";
import { MonthlyComparison, UsagePattern, formatTokenNumber, formatUsd } from "./analysisService";

// Opt-in only. The user pastes their own Gemini key. No key is bundled with the app.
export const AI_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 20_000;

/** The exact numbers that leave the browser. Shown to the user before they click. */
export function aiPayloadPreview(report: UsageReport, cmp: MonthlyComparison, pattern: UsagePattern): string[] {
  return [
    `Plan you chose: ${cmp.planKey} (${formatUsd(cmp.planPrice)}/mo)`,
    `Estimated pay-as-you-go cost: ${formatUsd(cmp.apiCostMonthly)}/mo`,
    `Tokens: ${formatTokenNumber(report.usage.tokens.input)} in, ${formatTokenNumber(report.usage.tokens.output)} out`,
    `Days with activity: ${pattern.activeDays} of ${pattern.periodDays}`,
  ];
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string };

export async function getGeminiRecommendation(
  apiKey: string,
  report: UsageReport,
  cmp: MonthlyComparison,
  pattern: UsagePattern,
): Promise<AiResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: "Paste a Gemini API key first." };

  // Numbers only. No text from the uploaded file goes into the prompt.
  const prompt = [
    "You are a plain-language advisor for a person deciding between a Claude subscription and pay-as-you-go API use.",
    "Write at most 3 short sentences. Use simple words. No headings, no bullet points.",
    "Say whether the subscription or pay-as-you-go is cheaper for this usage, and one practical next step.",
    "",
    `Plan: ${cmp.planKey}, ${formatUsd(cmp.planPrice)} per month.`,
    `Estimated pay-as-you-go cost: ${formatUsd(cmp.apiCostMonthly)} per month (list prices, 30-day scale).`,
    `Input tokens: ${report.usage.tokens.input}. Output tokens: ${report.usage.tokens.output}.`,
    `Days with activity: ${pattern.activeDays} of ${pattern.periodDays}.`,
  ].join("\n");

  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const call = ai.models.generateContent({
      model: AI_MODEL,
      contents: prompt,
      config: { temperature: 0.4 },
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
    );
    const response = await Promise.race([call, timeout]);
    const text = response.text?.trim();
    return text ? { ok: true, text } : { ok: false, error: "The AI returned an empty answer. Try again." };
  } catch (err) {
    const message = err instanceof Error && err.message === "timeout"
      ? "The AI took too long. Try again."
      : "The AI request failed. Check the key and try again.";
    return { ok: false, error: message };
  }
}
