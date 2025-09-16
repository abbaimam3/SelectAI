// server.js (updated: PDF upload support + LMS webhook stub)
import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import multer from "multer";
import pdfParse from "pdf-parse";

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

const CAND_FILE = "./candidates.json";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

function readCandidates() {
  try {
    const raw = fs.readFileSync(CAND_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    return [];
  }
}
function saveCandidates(list) {
  fs.writeFileSync(CAND_FILE, JSON.stringify(list, null, 2));
}

// LLM extractor - returns normalized candidate object
async function extractCandidateFromText(text, phone = "", extra = {}) {
  const prompt = `
You are a JSON extractor for applicant resumes and cover letters.
Read the provided INPUT and return ONLY the JSON object with these fields:
{
  "name": string,
  "email": string or "",
  "phone": string or "",
  "skills": [strings],
  "experience_years": number or 0,
  "education_level": one of ["none", "secondary", "diploma", "bachelors", "masters", "phd", "other"],
  "certifications": [strings] or [],
  "assessment_score": number or null,
  "summary": short string summarizing suitability,
  "raw_text_excerpt": short excerpt
}
INPUT:
"""${text}"""
If you cannot detect a field, return empty string, empty array, or 0/null as appropriate.
Return only valid JSON.
  `.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You extract structured data from resumes into JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      max_tokens: 500
    }),
  });

  const j = await resp.json();
  const txt = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) {
    return {
      name: extra.name || "",
      email: "",
      phone: phone || "",
      skills: [],
      experience_years: 0,
      education_level: "other",
      certifications: [],
      assessment_score: extra.assessment_score ?? null,
      summary: "",
      raw_text_excerpt: text.slice(0, 200)
    };
  }
  try {
    const parsed = JSON.parse(m[0]);
    parsed.phone = parsed.phone || phone || "";
    if (extra.assessment_score !== undefined) parsed.assessment_score = extra.assessment_score;
    return parsed;
  } catch (e) {
    return {
      name: extra.name || "",
      email: "",
      phone: phone || "",
      skills: [],
      experience_years: 0,
      education_level: "other",
      certifications: [],
      assessment_score: extra.assessment_score ?? null,
      summary: "",
      raw_text_excerpt: text.slice(0, 200)
    };
  }
}

// Scoring function
function computeScore(candidate, jobRequirements = {}) {
  const weights = {
    skills: jobRequirements.weights?.skills ?? 0.4,
    experience: jobRequirements.weights?.experience ?? 0.25,
    assessment: jobRequirements.weights?.assessment ?? 0.2,
    education: jobRequirements.weights?.education ?? 0.1,
    soft: jobRequirements.weights?.soft ?? 0.05
  };

  const reqSkills = (jobRequirements.skills || []).map(s => s.toLowerCase());
  const candSkills = (candidate.skills || []).map(s => s.toLowerCase());
  let skillScore = 0;
  if (reqSkills.length === 0) skillScore = 0.5;
  else {
    const matches = reqSkills.filter(rs => candSkills.some(cs => cs.includes(rs) || rs.includes(cs)));
    skillScore = matches.length / reqSkills.length;
  }

  const exp = Math.min(15, (candidate.experience_years || 0));
  const expScore = exp / 15;
  const assess = candidate.assessment_score;
  const assessScore = (assess === null || assess === undefined) ? 0.5 : Math.max(0, Math.min(100, assess)) / 100;
  const eduRank = { none:0, secondary:0.2, diploma:0.4, bachelors:0.6, masters:0.8, phd:1, other:0.4 };
  const eduScore = eduRank[candidate.education_level] ?? 0.4;
  const softScore = candidate.summary && candidate.summary.length > 20 ? 0.7 : 0.4;

  const final = skillScore*weights.skills + expScore*weights.experience + assessScore*weights.assessment + eduScore*weights.education + softScore*weights.soft;
  return Math.round(final * 100);
}

// API: upload resume text
app.post("/api/upload", async (req, res) => {
  try {
    const { text, name, email, phone, assessment_score, job_requirements } = req.body;
    if (!text) return res.status(400).json({ error: "text required (resume or cover letter)" });

    const extracted = await extractCandidateFromText(text, phone || "", { name: name || "", assessment_score: assessment_score ?? null });
    const id = uuidv4();
    const candidate = {
      id,
      created_at: new Date().toISOString(),
      raw_text: text.slice(0, 2000),
      extracted,
      score: null
    };
    const jobReq = job_requirements || { skills: [], weights: {} };
    const cscore = computeScore(extracted, jobReq);
    candidate.score = cscore;

    const list = readCandidates();
    list.push(candidate);
    saveCandidates(list);

    return res.json({ ok: true, id, score: cscore, extracted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal" });
  }
});

// API: upload PDF resume (multipart/form-data file field named 'file')
app.post("/api/upload_pdf", upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file required (PDF)" });
    const buffer = req.file.buffer;
    const data = await pdfParse(buffer);
    const text = data.text || "";
    // optional fields from form
    const name = req.body.name || "";
    const email = req.body.email || "";
    const phone = req.body.phone || "";
    const assessment_score = req.body.assessment_score ? Number(req.body.assessment_score) : null;
    const extracted = await extractCandidateFromText(text, phone, { name, assessment_score });
    const id = uuidv4();
    const candidate = {
      id,
      created_at: new Date().toISOString(),
      raw_text: text.slice(0, 2000),
      extracted,
      score: computeScore(extracted, req.body.job_requirements ? JSON.parse(req.body.job_requirements) : { skills: [], weights: {} })
    };
    const list = readCandidates();
    list.push(candidate);
    saveCandidates(list);
    return res.json({ ok: true, id, score: candidate.score, extracted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal", details: String(err) });
  }
});

// API: list ranked
app.get("/api/ranked", (req, res) => {
  const list = readCandidates();
  list.sort((a,b) => (b.score || 0) - (a.score || 0));
  res.json(list);
});

// API: export top N for LMS import
app.get("/api/export_top/:n", (req, res) => {
  const n = Math.max(1