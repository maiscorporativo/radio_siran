# Rádio Siran — rádio indoor

Plataforma de rádio indoor que mescla músicas (playlist) com spots de cada empresa,
automaticamente, com **fila ao vivo**: dá para subir um áudio e programá-lo durante a
programação, sem parar o som.

## Como funciona

```
 Painel (navegador)  ──►  Servidor Node (Hostinger OU notebook)  ◄──  Player (Chrome no notebook da loja)
 - empresas/unidades       - banco (MySQL ou SQLite)                  - toca playlist + spots
 - biblioteca de áudios    - arquivos de áudio                        - cache offline dos áudios
 - playlists               - API do painel e do player                - sincroniza a cada 5s
 - campanhas de spots                                                 - envia status + log de veiculação
 - fila ao vivo / comandos
 - relatório (CSV)
```

**Regras de spot (campanhas):** a cada N músicas, a cada N minutos ou em horários fixos.
Cada campanha pode ter período (início/fim), dias da semana, faixa de horário, prioridade e
unidade específica (ou todas).

**Ordem de decisão do player a cada troca de faixa:**
1. Fila ao vivo ("Tocar a seguir"), na ordem de chegada
2. Música interrompida por um "Tocar agora" (retoma de onde parou)
3. Spots de campanhas que estão devidos (tocam em bloco, por prioridade)
4. Próxima música da playlist (aleatória ou em ordem)

"**Tocar agora**" interrompe com fade em até ~5 segundos.

**Sem internet:** o player guarda os áudios e a programação no navegador e continua tocando.
Os logs de veiculação ficam acumulados e são enviados quando a conexão volta.

## Rodar localmente (teste ou modo 100% notebook)

```bash
npm install
cp .env.example .env      # ajuste ADMIN_PASSWORD e SESSION_SECRET
npm start                 # http://localhost:3000
```

No Windows, dá para usar `scripts\iniciar-local.bat`.

Primeiros passos no painel: **+ Empresa** → **Biblioteca** (enviar músicas e spots) →
**Playlists** → **Unidades** (criar e escolher a playlist) → **Spots** (campanhas) →
abrir o **link do player** no notebook.

## Deploy na Hostinger

Funciona tanto em **hospedagem com Node.js** (planos Business/Cloud) quanto em **VPS**.

### Hospedagem com Node.js (hPanel)
1. hPanel → **Bancos de dados MySQL** → crie banco, usuário e senha.
2. hPanel → **Sites → Adicionar site → Node.js App** (ou "Node.js" no site existente).
   Envie o projeto (via GitHub ou upload do .zip **sem** `node_modules`, `data`, `uploads`).
   - Arquivo de entrada: `server/index.js`
   - Versão do Node: 20 ou superior
3. Variáveis de ambiente (no painel do app ou num arquivo `.env`):
   ```
   DB_CLIENT=mysql
   DB_HOST=...  DB_PORT=3306  DB_USER=...  DB_PASSWORD=...  DB_NAME=...
   ADMIN_USER=...  ADMIN_PASSWORD=...  SESSION_SECRET=<string longa aleatória>
   MAX_UPLOAD_MB=80
   TZ=America/Sao_Paulo
   ```
4. Ative **SSL** no domínio. HTTPS é necessário para o cache offline do player.
5. As tabelas são criadas automaticamente na primeira inicialização.

> Os áudios ficam na pasta `uploads/`. Confira se o plano tem espaço suficiente:
> uma música MP3 tem cerca de 4 a 8 MB.

### VPS (Ubuntu)
```bash
# Node 20+, git, pm2
git clone <repo> radiosiran && cd radiosiran
npm install --omit=dev && cp .env.example .env && nano .env
npx pm2 start server/index.js --name radio && npx pm2 save && npx pm2 startup
```
Coloque um Nginx com SSL na frente (proxy para a porta 3000) e ajuste
`client_max_body_size 100M;` para permitir uploads grandes.

## Notebook da loja

1. Instale o **Google Chrome**.
2. Rode `scripts\instalar-notebook.bat` e cole o **link do player** da unidade.
   O script:
   - desativa suspensão e hibernação na tomada e faz a tampa fechada não fazer nada;
   - cria a inicialização automática do Chrome em **tela cheia (kiosk)**, com autoplay liberado.
3. Deixe o notebook **na tomada** e com o som ligado.

Pelo painel (aba **Ao vivo**) você controla cada unidade: pular, pausar, retomar, volume,
fila e recarregar o player remotamente.

## Spotify (uso pessoal, não comercial)

Cada unidade pode usar **Spotify** como fonte das músicas, em vez do acervo próprio.
Os spots, a fila ao vivo e os comandos continuam funcionando.

**Como funciona:** o Chrome do player vira um "aparelho Spotify" (Web Playback SDK), e a
Web API escolhe a playlist e controla a reprodução. Perto do fim de cada faixa, se houver
spot ou item na fila, o player abaixa o volume, pausa o Spotify, toca os spots e segue para
a próxima faixa. "Tocar agora" pausa a faixa no meio e depois retoma do mesmo ponto.

**Configuração (uma vez):**
1. Acesse https://developer.spotify.com/dashboard com a conta Premium e clique em **Create app**.
   - APIs: marque **Web API** e **Web Playback SDK**.
   - Redirect URI:
     - notebook: `http://127.0.0.1:3000/player/callback.html`
     - Hostinger: `https://SEU-DOMINIO/player/callback.html`
2. Copie o **Client ID** para o `.env` (`SPOTIFY_CLIENT_ID=...`) e reinicie o servidor.
   Não é preciso o Client Secret.
3. No painel, em **Unidades**, escolha a fonte **Spotify** e cole o link da playlist
   (Spotify → Compartilhar → Copiar link da playlist).
4. Abra o player e clique em **Conectar Spotify**. É só a primeira vez; depois ele
   renova o acesso sozinho.

**Requisitos:** conta Premium, Chrome ou Edge no computador e internet. Sem internet o
Spotify para; spots e fila continuam vindo do cache. Se a mesma conta for usada em outro
aparelho, o player perde a reprodução e tenta retomar.

**Segurança:**
- O login usa **PKCE**, o fluxo indicado pelo Spotify para apps sem servidor de login. A senha
  do Spotify é digitada só no site do Spotify, e nenhum segredo fica no código.
- O acesso fica guardado apenas no navegador do player. O servidor não guarda tokens do Spotify.
- As permissões pedidas são só as de tocar e controlar a reprodução, e ler playlists.
- Para revogar: spotify.com → Conta → **Apps** → remover o app.

## Licenciamento musical (importante)

Use apenas músicas com licença para **execução pública comercial** (bibliotecas para
estabelecimentos, royalty-free com licença comercial ou acervo próprio) e mantenha o
**ECAD** em dia. Músicas do Spotify, YouTube etc. não podem ser usadas comercialmente.
