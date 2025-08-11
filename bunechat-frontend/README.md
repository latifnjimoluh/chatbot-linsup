# BUNEC Chatbot Frontend

Interface React pour interagir avec l'API du chatbot BUNEC.

## Installation

```bash
cd bunechat-frontend
npm install
```

## Configuration

Crée un fichier `.env` à la racine :

```env
VITE_API_URL=http://localhost:3002
VITE_CLIENT_TOKEN=change-me # optionnel si auth désactivée
```

## Démarrer en développement

```bash
npm run dev
```

## Lancer le lint

```bash
npm run lint
```

## Build de production

```bash
npm run build
```

L'application attend les routes suivantes exposées par le backend :

- `POST /chatbot/ask`
- `POST /chatbot/ask/stream`
- `POST /chatbot/ask/rag`
- `POST /chatbot/agent`
- `GET  /kb/stats`
- `POST /kb/reload`
- `GET  /kb/file?source=<fichier>`

Tous les appels réseau passent par ces endpoints, aucun mock n'est utilisé.
