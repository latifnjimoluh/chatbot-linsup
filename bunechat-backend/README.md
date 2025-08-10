# BUNEC Chatbot Backend

API Node.js + Express pour le chatbot BUNEC.

## Installation

```bash
cd bunechat-backend
npm install
```

## Configuration

Créer un fichier `.env` :

```env
PORT=3002
ALLOWED_ORIGIN=http://localhost:5173
GEMINI_API_KEY=...
MODEL_ID=gemini-1.5-flash
MODEL_FALLBACK_ID=gemini-1.5-flash-8b
KB_DIR=knowledge_base
VECTOR_DIR=vectorstore
RAG_TOP_K=3
RAG_MIN_SCORE=0.35
RAG_QVARIANTS=2
RAG_ARBITER=rules
RAG_MAX_CONTEXT_CHARS=8000
RATE_LIMIT_MAX=30
```

## Démarrer le serveur

```bash
npm run dev
```

## Endpoints

- `POST /chatbot/ask`
- `POST /chatbot/ask/stream`
- `POST /chatbot/ask/rag`
- `GET  /kb/stats`
- `POST /kb/reload`
- `GET  /kb/file?source=<fichier>`

## Outils

- `npm run kb:index` : indexer la base de connaissances
- `npm run kb:clear` : supprimer l'index
- `npm run test:latency` : petit test réseau

Tous les journaux de conversations sont stockés dans `logs/chat.log`.

Le schéma SQL proposé pour stocker ces échanges se trouve dans `../schema.sql`.
