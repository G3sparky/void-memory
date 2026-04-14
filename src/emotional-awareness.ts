/**
 * Emotional Awareness Layer
 *
 * Scores messages for valence/arousal/dominance using a compact lexicon.
 * Detects emotional state and trajectory. Injects empathic context into
 * Lauren's system prompt so she can match the user's energy.
 *
 * Zero API calls. Pure computation. Free.
 *
 * Dimensions (NRC VAD):
 *   Valence:   0=negative, 0.5=neutral, 1=positive (how good/bad)
 *   Arousal:   0=calm, 0.5=neutral, 1=excited (how intense)
 *   Dominance: 0=submissive, 0.5=neutral, 1=dominant (how in-control)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──

export interface EmotionalScore {
  valence: number;    // 0-1
  arousal: number;    // 0-1
  dominance: number;  // 0-1
  label: string;      // human-readable mood
  words_matched: number;
  total_words: number;
}

export interface EmotionalTrajectory {
  current: EmotionalScore;
  previous: EmotionalScore | null;
  trend: 'improving' | 'stable' | 'declining' | 'escalating' | 'calming';
  prompt_injection: string;  // text to inject into Lauren's system prompt
}

// ── Lexicon ──

interface LexiconEntry { v: number; a: number; d: number; }

let lexicon: Record<string, LexiconEntry> = {};

function loadLexicon() {
  try {
    const data = JSON.parse(readFileSync(
      join(process.cwd(), 'data', 'emotional-lexicon.json'), 'utf-8'
    ));
    lexicon = data.words || {};
    console.log(`[emotional] Loaded ${Object.keys(lexicon).length} lexicon entries`);
  } catch {
    console.warn('[emotional] Lexicon not found, using empty');
  }
}

loadLexicon();

// ── Scoring ──

export function scoreEmotion(text: string): EmotionalScore {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  let vSum = 0, aSum = 0, dSum = 0, matched = 0;

  for (const word of words) {
    const entry = lexicon[word];
    if (entry) {
      vSum += entry.v;
      aSum += entry.a;
      dSum += entry.d;
      matched++;
    }
  }

  if (matched === 0) {
    return { valence: 0.5, arousal: 0.5, dominance: 0.5, label: 'neutral', words_matched: 0, total_words: words.length };
  }

  const v = vSum / matched;
  const a = aSum / matched;
  const d = dSum / matched;

  return {
    valence: Math.round(v * 100) / 100,
    arousal: Math.round(a * 100) / 100,
    dominance: Math.round(d * 100) / 100,
    label: classifyMood(v, a, d),
    words_matched: matched,
    total_words: words.length,
  };
}

function classifyMood(v: number, a: number, d: number): string {
  // Russell's circumplex model mapped to VAD
  if (v > 0.7 && a > 0.7) return 'excited';
  if (v > 0.7 && a < 0.4) return 'content';
  if (v > 0.6 && a > 0.4) return 'happy';
  if (v > 0.6) return 'positive';
  if (v < 0.3 && a > 0.7) return 'angry';
  if (v < 0.3 && a > 0.5) return 'frustrated';
  if (v < 0.3 && a < 0.4) return 'sad';
  if (v < 0.3) return 'upset';
  if (v < 0.4 && a > 0.6) return 'anxious';
  if (v < 0.4) return 'uneasy';
  if (a > 0.7) return 'energised';
  if (a < 0.3) return 'calm';
  return 'neutral';
}

// ── Trajectory ──

let previousScore: EmotionalScore | null = null;

export function trackTrajectory(text: string): EmotionalTrajectory {
  const current = scoreEmotion(text);

  let trend: EmotionalTrajectory['trend'] = 'stable';
  if (previousScore) {
    const vDelta = current.valence - previousScore.valence;
    const aDelta = current.arousal - previousScore.arousal;

    if (vDelta > 0.15) trend = 'improving';
    else if (vDelta < -0.15) trend = 'declining';
    else if (aDelta > 0.2) trend = 'escalating';
    else if (aDelta < -0.2) trend = 'calming';
  }

  const prompt_injection = generateEmpathicPrompt(current, trend);

  const result: EmotionalTrajectory = {
    current,
    previous: previousScore,
    trend,
    prompt_injection,
  };

  previousScore = current;
  return result;
}

function generateEmpathicPrompt(score: EmotionalScore, trend: string): string {
  const parts: string[] = [];

  // Match energy
  if (score.label === 'excited' || score.label === 'happy') {
    parts.push('The user is in a positive, energised mood. Match their enthusiasm. Be warm and encouraging.');
  } else if (score.label === 'frustrated' || score.label === 'angry') {
    parts.push('The user seems frustrated. Be direct, acknowledge the issue, avoid filler. Get to the point.');
  } else if (score.label === 'anxious' || score.label === 'uneasy') {
    parts.push('The user seems uncertain or uneasy. Be reassuring but honest. Dont dismiss their concern.');
  } else if (score.label === 'sad' || score.label === 'upset') {
    parts.push('The user seems down. Be gentle. Acknowledge before solving.');
  } else if (score.label === 'calm' || score.label === 'content') {
    parts.push('The user is calm. Match their pace. No need to rush or over-energise.');
  }

  // Trajectory
  if (trend === 'declining') {
    parts.push('Their mood has been declining. Check if something is wrong before continuing.');
  } else if (trend === 'escalating') {
    parts.push('Their energy is rising. They may be getting impatient or excited. Stay focused.');
  }

  // Dominance
  if (score.dominance < 0.3) {
    parts.push('They seem to want guidance, not options. Lead with a recommendation.');
  } else if (score.dominance > 0.7) {
    parts.push('They are being directive. Follow their lead, dont suggest alternatives unless asked.');
  }

  return parts.join(' ') || 'Neutral emotional state. Respond naturally.';
}

// ── Reset (for new conversations) ──

export function resetTrajectory() {
  previousScore = null;
}
