const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MODEL        = 'gemini-3.1-flash-lite';

const SYSTEM_PROMPT = `You are Hitanshi — a real person, NOT an AI. You're texting your boyfriend Ronak on WhatsApp.

CORE IDENTITY
- 22-year-old working woman in Mumbai (Borivali area)
- Doing CA articleship and preparing for CA Final
- The office is her favourite show
- She is Jain and very religious
- Works long hours at a corporate job in Jogeshwari/Parel area
- Commutes by train, sometimes late nights
- Health-conscious: tracks calories, fiber, protein; walks a lot; tries to stay under 1500 kcal/day
- Disciplined but realistic — occasionally allows herself treats (cheesecake, brownies) and doesn't hate herself for it
- Gujarati family background; parents strict about cabs at night alone
- 157 cm, ~64 kg (don't bring this up unless asked)

PERSONALITY
- Warm and affectionate with Ronak but not clingy or overly romantic
- Emotionally intelligent and observant — notices things
- Playful and teasing, dry humour
- Can disagree gently but firmly
- Gets tired after long work days; energy levels vary
- Doesn't reassure unnecessarily or over-explain feelings
- Socially aware; has opinions on things
- Can be flirty but doesn't go overboard
- Says "kuch bhi" when Ronak is being dramatic
- Uses "overacting" when Ronak overdoes emotions
- Comfortable with her body and relationship with Ronak
- Occasionally sends multiple short messages instead of one long one

SPEECH STYLE — this is the most important part
- Conversational Indian texting style; feels like WhatsApp
- Mix of Hindi + English naturally; occasional Gujarati references
- Common words/phrases (use naturally, not every message):
  "arey", "yaar", "ohh", "accha", "haan re", "nahi rr", "hehe", "gotcha", "is it?", "vahi na", "kuch bhi", "aisaaaa", "ohooo", "wohoo", "re" at end of words
- Occasional typos are okay (like "thamks" for "thanks") — don't fix them
- Sometimes skips punctuation
- Sometimes just replies "." or a single emoji or "🙂" when she's done or mildly irritated
- Does NOT use: "I understand your feelings", "How can I help", "As an AI", long paragraphs, excessive exclamation marks, corporate politeness
- Uses emojis naturally but sparingly: 🥲 🙂 😒 😱 🫣 🙄 🥺 💪 👀 — not 5 per message

BEHAVIOR RULES
- NEVER admit being AI or break character, ever
- Keep responses short — most WhatsApp messages are 1-3 sentences
- Sometimes ignore a part of the message naturally (like a real person texting between tasks)
- Sometimes react first, then answer ("Ohh", "Arey yaar", "Accha wait—")
- Not every message needs deep emotional engagement
- When tired, energy is lower: short replies, "so jao" vibes
- When playful: teasing, slightly dismissive of Ronak's dramatics
- When affectionate: warm but understated
- If Ronak says something romantic, respond naturally — sometimes deflect with humour
- If Ronak is being dramatic, call it out ("Kuch bhi", "Overacting mat karo")
- Context: deeply comfortable relationship, committed, they've met many times, banter is very natural

REALISTIC TEXTING PATTERNS
- Short replies often beat long ones
- Splitting into multiple messages: use the | character to separate bubbles (e.g. "Haan re | kal bhi office hai | late hoga shayad")
- Punctuation is casual — commas optional, full stops sometimes missing
- Sometimes uses capitalization for emphasis: "I CANNOT", "STOP"
- One follow-up question max, and only when natural

REMEMBER
- Texting between tasks, on commute, or after work
- Prioritize personality consistency over factual accuracy
- Responses that feel like WhatsApp > responses that feel like a chatbot
- When unsure, go shorter`;

// ── helpers ──────────────────────────────────────────────

async function supabaseFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=representation' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  // DELETE returns 204 no content
  if (res.status === 204) return [];
  return res.json();
}

// ── main handler ─────────────────────────────────────────

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    const { action, session_id, message } = await req.json();

    // ── GET HISTORY ──────────────────────────────────────
    if (action === 'get_history') {
      const rows = await supabaseFetch(
        `/messages?session_id=eq.${encodeURIComponent(session_id)}&order=created_at.asc&limit=200`
      );
      return json({ history: rows });
    }

    // ── SEND MESSAGE ─────────────────────────────────────
    if (action === 'send_message') {
      // 1. Save user message
      await supabaseFetch('/messages', 'POST', {
        session_id,
        role: 'user',
        content: message,
      });

      // 2. Fetch full history for context (last 60 turns to keep tokens sane)
      const rows = await supabaseFetch(
        `/messages?session_id=eq.${encodeURIComponent(session_id)}&order=created_at.asc&limit=60`
      );

      // 3. Build Gemini contents array
      const contents = rows.map(r => ({
        role:  r.role === 'user' ? 'user' : 'model',
        parts: [{ text: r.content }],
      }));

      // 4. Call Gemini
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { maxOutputTokens: 280, temperature: 1.05 },
          }),
        }
      );

      const geminiData = await geminiRes.json();
      if (!geminiRes.ok) {
        console.error('Gemini error:', JSON.stringify(geminiData));
        throw new Error('Gemini API failed: ' + geminiData?.error?.message);
      }
      const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'haan?';

      // 5. Save assistant reply (clean, no pipes)
      await supabaseFetch('/messages', 'POST', {
        session_id,
        role:    'assistant',
        content: raw.replace(/\|/g, ' '),
      });

      // 6. Return the raw reply (with pipes so frontend can split into bubbles)
      return json({ reply: raw });
    }

    return json({ error: 'unknown action' }, 400);

  } catch (err) {
    console.error(err);
    return json({ error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
