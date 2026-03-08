import { createClient } from "npm:@supabase/supabase-js@2";

type Hotspot = {
  latitude: number;
  longitude: number;
  acq_date?: string;
  acq_time?: string;
  confidence?: string | number;
};

type NewsItem = {
  id: string;
  title: string;
  description?: string;
  url?: string;
  published_at?: string;
  source?: string;
};

type GeminiGeo = {
  lat: number | null;
  lon: number | null;
  location?: string | null;
  confidence?: number | null;
};

function toNumber(x: unknown): number | null {
  const n = typeof x === "string" ? parseFloat(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseCSV(csv: string): Hotspot[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const idxLat = header.findIndex((h) => h.toLowerCase().includes("latitude"));
  const idxLon = header.findIndex((h) => h.toLowerCase().includes("longitude"));
  const idxDate = header.findIndex((h) => h.toLowerCase().includes("acq_date"));
  const idxTime = header.findIndex((h) => h.toLowerCase().includes("acq_time"));
  const idxConf = header.findIndex((h) => h.toLowerCase().includes("confidence"));
  const res: Hotspot[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const lat = toNumber(cols[idxLat]);
    const lon = toNumber(cols[idxLon]);
    if (lat === null || lon === null) continue;
    res.push({
      latitude: lat,
      longitude: lon,
      acq_date: idxDate >= 0 ? cols[idxDate] : undefined,
      acq_time: idxTime >= 0 ? cols[idxTime] : undefined,
      confidence: idxConf >= 0 ? cols[idxConf] : undefined,
    });
  }
  return res;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const sLat1 = (aLat * Math.PI) / 180;
  const sLat2 = (bLat * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(sLat1) * Math.cos(sLat2);
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

async function callGeminiExtract(apiKey: string, text: string): Promise<GeminiGeo> {
  const model = "models/gemini-1.5-flash";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;
  const prompt =
    "Extract geographic coordinates in decimal degrees from the following conflict news text. " +
    "Return strict JSON with keys lat, lon, location, confidence. " +
    "Use null if unknown. Text: " +
    text.slice(0, 8000);
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { lat: null, lon: null, location: null, confidence: null };
  const data = await resp.json();
  const txt =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data ??
    "";
  const cleaned = String(txt)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const j = JSON.parse(cleaned);
    const lat = toNumber(j.lat);
    const lon = toNumber(j.lon);
    const confidence = toNumber(j.confidence);
    const location = j.location ?? null;
    return { lat, lon, location, confidence: confidence ?? null };
  } catch {
    return { lat: null, lon: null, location: null, confidence: null };
  }
}

function normalizeNewsPayload(payload: unknown): NewsItem[] {
  if (Array.isArray(payload)) {
    return payload
      .slice(0, 50)
      .map((x, i) => {
        const id =
          (x as any).id ??
          (x as any).url ??
          `${(x as any).title ?? "news"}-${i}-${Date.now()}`;
        return {
          id: String(id),
          title: String((x as any).title ?? (x as any).headline ?? "Untitled"),
          description:
            (x as any).description ??
            (x as any).summary ??
            (x as any).content ??
            "",
          url: (x as any).url ?? (x as any).link ?? undefined,
          published_at: (x as any).published_at ?? (x as any).pubDate ?? undefined,
          source: (x as any).source ?? (x as any).domain ?? undefined,
        };
      });
  }
  const obj = payload as any;
  if (obj?.articles && Array.isArray(obj.articles)) {
    return obj.articles.slice(0, 50).map((x: any, i: number) => ({
      id: String(x.id ?? x.url ?? `${x.title ?? "news"}-${i}-${Date.now()}`),
      title: String(x.title ?? "Untitled"),
      description: String(x.description ?? x.content ?? ""),
      url: x.url,
      published_at: x.published_at ?? x.publishedAt ?? undefined,
      source: x.source?.name ?? x.source ?? undefined,
    }));
  }
  return [];
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(50, Number(limitParam))) : 20;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
    const NASA_FIRMS_CSV_URL = Deno.env.get("NASA_FIRMS_CSV_URL") ?? "";
    const OSINT_NEWS_API_URL = Deno.env.get("OSINT_NEWS_API_URL") ?? "";
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase service env" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: "Missing Gemini API key" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!NASA_FIRMS_CSV_URL) {
      return new Response(JSON.stringify({ error: "Missing NASA_FIRMS_CSV_URL" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!OSINT_NEWS_API_URL) {
      return new Response(JSON.stringify({ error: "Missing OSINT_NEWS_API_URL" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [nasaRes, newsRes] = await Promise.all([
      fetch(NASA_FIRMS_CSV_URL, { method: "GET" }),
      fetch(OSINT_NEWS_API_URL, { method: "GET" }),
    ]);
    if (!nasaRes.ok) {
      return new Response(JSON.stringify({ error: "NASA fetch failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    const nasaCsv = await nasaRes.text();
    const hotspots = parseCSV(nasaCsv);
    if (!newsRes.ok) {
      return new Response(JSON.stringify({ error: "OSINT fetch failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    const newsJson = await newsRes.json().catch(() => null);
    const items = normalizeNewsPayload(newsJson).slice(0, limit);
    const outputs: any[] = [];

    for (const item of items) {
      const text = `${item.title}\n${item.description ?? ""}`.trim();
      const geo = await callGeminiExtract(GEMINI_API_KEY, text);
      let verified = false;
      let matched: Hotspot | null = null;
      let distanceKm: number | null = null;
      if (geo.lat !== null && geo.lon !== null && hotspots.length) {
        let bestDist = Infinity;
        let best: Hotspot | null = null;
        for (const h of hotspots) {
          const d = haversineKm(geo.lat, geo.lon, h.latitude, h.longitude);
          if (d < bestDist) {
            bestDist = d;
            best = h;
          }
        }
        if (best) {
          verified = bestDist <= 10;
          matched = best;
          distanceKm = Math.round(bestDist * 100) / 100;
        }
      }
      outputs.push({
        news_id: item.id,
        title: item.title,
        summary: item.description ?? null,
        source_url: item.url ?? null,
        source: item.source ?? null,
        lat: geo.lat,
        lon: geo.lon,
        location_text: geo.location ?? null,
        confidence_score: geo.confidence ?? null,
        verified,
        matched_hotspot_lat: matched?.latitude ?? null,
        matched_hotspot_lon: matched?.longitude ?? null,
        matched_hotspot_date: matched?.acq_date ?? null,
        matched_hotspot_time: matched?.acq_time ?? null,
        matched_hotspot_confidence: matched?.confidence ?? null,
        distance_km: distanceKm,
        model: "gemini-1.5-flash",
        timestamp: new Date().toISOString(),
        type: "conflict_news",
      });
    }

    const { error } = await supabase
      .from("global_intelligence")
      .upsert(outputs, { onConflict: "news_id" });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        processed: outputs.length,
        verified: outputs.filter((o) => o.verified).length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
