FROM node:20-slim

WORKDIR /app

# Sem dependências npm — server.mjs usa só built-ins
COPY package.json server.mjs index.html ./

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.mjs"]
