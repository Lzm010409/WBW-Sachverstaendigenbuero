# Auth-Vorschalter fuer den Kleinanzeigen-Dienst.
# Bewusst winzig: ein Node-Bordmittel-Skript, keine Abhaengigkeiten, kein
# Paketmanager-Aufruf beim Bauen - es gibt nichts zu installieren.
FROM node:22-alpine

WORKDIR /app
COPY proxy.js ./

ENV PROXY_PORT=8080
EXPOSE 8080

# Der Vorschalter gilt als gesund, wenn er eine Anfrage OHNE Zugangsdaten mit 401
# beantwortet. Das prueft in einem Zug, dass er laeuft UND dass er schuetzt - ein
# stiller Ausfall des Zugriffsschutzes faellt so beim Ausrollen auf.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PROXY_PORT||8080,path:'/'},r=>process.exit(r.statusCode===401?0:1)).on('error',()=>process.exit(1))"

USER node
CMD ["node", "proxy.js"]
