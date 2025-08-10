// adapters/search/pinecone.js
// Backend Pinecone (base vectorielle managée).
// ⚠️ Nécessite: npm i @pinecone-database/pinecone
// Variables .env: PINECONE_API_KEY, PINECONE_INDEX, (optionnel) PINECONE_NAMESPACE

import { Pinecone } from "@pinecone-database/pinecone";

export default function pineconeAdapter() {
  const apiKey = process.env.PINECONE_API_KEY || "";
  const indexName = process.env.PINECONE_INDEX || "";
  const namespace = process.env.PINECONE_NAMESPACE || undefined;

  let client = null;
  let index = null;

  async function init() {
    if (!apiKey || !indexName) {
      throw new Error(
        "PINECONE_NOT_CONFIGURED: définis PINECONE_API_KEY et PINECONE_INDEX, " +
        "ou mets SEARCH_BACKEND=json."
      );
    }
    if (!client) {
      client = new Pinecone({ apiKey });
      index = client.index(indexName);
    }
  }

  return {
    name: "pinecone",

    async ensureReady() {
      await init();
    },

    // Côté Pinecone, rien à recharger (les données sont managées).
    async reload() {
      return true;
    },

    /**
     * Recherche les k chunks les plus proches d'un vecteur de requête.
     * @param {Float32Array|number[]} qVec
     * @param {number} k
     * @param {number|null} minScore - seuil de similarité (0..1) ou null pour désactiver
     * @returns {Promise<Array<{ text:string, metadata:any, score:number|null }>>}
     */
    async searchByVector(qVec, k = 3, minScore = null) {
      await init();

      // Pinecone exige un array JS classique
      const vector = Array.from(qVec);

      const res = await index.query({
        vector,
        topK: k,
        includeValues: false,
        includeMetadata: true,
        ...(namespace ? { namespace } : {}),
      });

      const matches = Array.isArray(res?.matches) ? res.matches : [];
      const hits = matches.map((m) => {
        const md = m.metadata || {};
        return {
          text: md.text || "",
          metadata: {
            source: md.source || "unknown",
            chunk: md.chunk ?? null,
            ...md,
          },
          score: typeof m.score === "number" ? m.score : null,
        };
      });

      // Filtre par seuil si demandé
      return minScore == null ? hits : hits.filter((h) => (h.score ?? 0) >= minScore);
    },
  };
}
