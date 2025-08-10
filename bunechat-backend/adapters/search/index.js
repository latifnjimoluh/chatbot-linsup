// adapters/search/index.js
// Sélecteur d’implémentation pour la recherche vectorielle (JSON par défaut).
// Interface exposée par getSearch():
//   { name, ensureReady?(), reload?(), stats?(), search({queries, topK, minScore, mmr, preview}) }

import * as json from "./json.js";
// import * as pinecone from "./pinecone.js" // à activer plus tard si besoin

const BACKEND = (process.env.SEARCH_BACKEND || "json").toLowerCase();

export function getSearch() {
  switch (BACKEND) {
    case "json": {
      return {
        name: "json",
        ensureReady: json.ensureReady, // vérifie index + clé embeddings
        reload: json.reload,
        stats: json.stats,
        search: json.search,
      };
    }
    // case "pinecone":
    //   return { name: "pinecone", ...pinecone };
    default: {
      return {
        name: "json",
        ensureReady: json.ensureReady,
        reload: json.reload,
        stats: json.stats,
        search: json.search,
      };
    }
  }
}
