# Centro de sesiones de Claude Code

Página local que muestra todas las sesiones de Claude Code abiertas en esta máquina, con su estado (trabajando / terminado / te pregunta), tu último prompt y la última respuesta. Avisa con una notificación de Windows cuando una sesión termina o te pregunta.

No toca la configuración de Claude Code: lee `~/.claude/sessions/*.json` (registro de sesiones vivas) y `~/.claude/projects/**/*.jsonl` (transcripts) y reacciona a los cambios del sistema de ficheros.

## Uso

```
node server.mjs
```

Abre <http://localhost:4747>. `PORT=5000 node server.mjs` para cambiar el puerto. `node server.mjs --once` imprime el JSON de sesiones y sale.

## Ficheros

- `server.mjs`: servidor (Node, sin dependencias), SSE en `/events`
- `index.html`: la página
- `notify.ps1`: notificación de Windows + sonido (Windows PowerShell 5.1)
