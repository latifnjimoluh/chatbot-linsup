app.post("/chatbot/ask/rag", async (req, res) => {
  const started = Date.now();
  const rid = req.id || nanoid(10);

  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] requis" });
    }

    const lastUserMsg = [...messages].reverse().find(m => m?.role === "user")?.content || "";
    if (!lastUserMsg.trim()) {
      return res.status(400).json({ error: "question vide" });
    }

    // 1) charge l’index + embedding de la question
    const { dim } = loadIndexOnce();
    const embedder = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: "text-embedding-004",
    });
    const qVec = await embedder.embedQuery(lastUserMsg);
    if (qVec.length !== dim) {
      if (qVec.length > dim) qVec.length = dim;
      else while (qVec.length < dim) qVec.push(0);
    }

    // 2) Similarity search
    const hits = topK(Float32Array.from(qVec), RAG_TOP_K);
    const ctx = hits.map((h, i) =>
      `#${i + 1} [${h.doc.metadata?.source || "source"}]\n${h.doc.text}`
    ).join("\n\n---\n\n");
    const sources = hits.map(h => h.doc.metadata?.source || "source");

    // 3) Prompt
    const RAG_RULES =
      "Tu dois t'appuyer STRICTEMENT sur le CONTEXTE fourni. " +
      "Quand c'est pertinent, cite les fichiers utilisés dans une section 'Sources:' (noms de fichiers). " +
      "Si l'info n'est pas dans le contexte, dis-le et propose une piste pour la trouver dans la base.";

    const prompt =
`SYSTEM:
${SYSTEM_PROMPT}

RÈGLES RAG:
${RAG_RULES}

CONTEXTE (extraits, top ${RAG_TOP_K}):
${ctx}

QUESTION:
${lastUserMsg}

INSTRUCTION:
- Réponds en français, technique et concise.
- Si tu utilises des extraits, inclue 'Sources: <fichiers>' à la fin.`;

    const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
    ]);

    const text = result?.response?.text?.() || "Désolé, je n'ai pas pu générer de réponse.";
    const durationMs = Date.now() - started;

    // log si dispo
    try {
      fs.appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "logs", "chat.log"),
        JSON.stringify({ rid, t:new Date().toISOString(), ip:req.ip, durationMs, ok:true, mode:"rag-json", qChars:lastUserMsg.length, aChars:text.length, sources }) + "\n"
      );
    } catch {}

    return res.json({ reply: text, meta: { durationMs, rid, sources } });
  } catch (err) {
    const durationMs = Date.now() - started;
    const status = err.message === "timeout" ? 504 : 500;

    if (String(err.message).includes("VECTOR_INDEX_NOT_FOUND")) {
      return res.status(503).json({
        error: "vector_index_absent",
        hint: "Lancez `npm run kb:index` pour construire l'index.",
        rid, durationMs
      });
    }

    return res.status(status).json({ error: "LLM_error", rid, durationMs });
  }
});
