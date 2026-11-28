# FF-Salas-API

Portal web em português para organizar salas personalizadas de Free Fire pela API pública da Lobbito. Crie treinos e partidas com regras de personagens e pets, compartilhe o acesso e acompanhe os resultados no mesmo painel. Cada organizador usa a chave e a cota da sua conta. [Conheça a Lobbito API](https://api.lobbito.com.br/) · [Documentação oficial](https://api.lobbito.com.br/docs)

- Crie salas de Contra Squad ou Battle Royale e compartilhe o ID e a senha com os jogadores.
- Bloqueie habilidades ativas e passivas de personagens escolhidos e veja quem precisa ajustar as habilidades antes da partida.
- Configure o visual e a habilidade de pet em regras separadas, conforme os catálogos disponíveis na Lobbito.
- Inicie partidas, cancele salas e acompanhe o histórico da sua conta.
- Receba resultados e avisos de conferência por webhook quando o portal estiver hospedado em HTTPS.

## Executar localmente

Com Node.js 22.13 ou superior, clone o repositório e inicie o portal.

```sh
git clone https://github.com/dennerewerton/FF-Salas-API.git
cd FF-Salas-API
npm start
```

Se baixou o ZIP, execute `npm start` na pasta extraída. O projeto usa os módulos nativos do Node.js e os arquivos estáticos de `public`. [Abrir o portal local](http://127.0.0.1:3080)

## Criar uma sala

1. No [painel da Lobbito](https://api.lobbito.com.br/painel), gere uma chave da sua conta e use **Conexão API** no portal.
2. Escolha Contra Squad (1x1 a 4x4) ou Battle Royale (Solo, Dupla ou Esquadrão), o mapa e, em Battle Royale, a capacidade. Deixe a senha em branco para que a API gere uma.
3. Em **Bloqueio de personagens** ou **Regras de pets**, busque e marque os itens que devem ficar fora da partida. Em **Opções avançadas**, ajuste as outras regras ou cadastre os jogadores para ativar o início automático.
4. Clique em **Criar sala**. Quando a Lobbito confirmar a criação, copie o ID e a senha para compartilhar com os jogadores.

Use **Predefinição** para preencher as opções de Duplas CS, CS só capa ou Esquadrão BR e ajuste o restante antes de criar a sala. **Experimentar demonstração** simula a criação, o início e o resultado no navegador, sem chave e sem consumir cota.

O **Histórico de salas** consulta as salas da própria conta. Se a conexão cair, **Verificar pedido** reutiliza o mesmo protocolo. Ao reconectar após um reinício, o portal consulta a Arena pelo protocolo ou pelo ID que a Arena já confirmou. Se a Arena ainda estiver sem uma sala para o pedido, **Encerrar pedido sem sala** bloqueia a criação com aquele protocolo e libera um novo pedido. A Arena só permite encerrar dessa forma quando o protocolo ainda não está vinculado a uma sala.

## Bloqueio de personagens

Disponível em Contra Squad e Battle Royale. A seleção usa o catálogo da Lobbito e vale para as habilidades ativas e passivas que os jogadores equiparem. A aparência do personagem no jogo continua livre. Ao usar a regra, deixe pelo menos um personagem liberado. A Lobbito confere as habilidades antes do início e o portal mostra os IDs dos jogadores que precisam ajustar a seleção. [Regras de criação e início da Lobbito](https://api.lobbito.com.br/docs#criar-sala)

## Regras de pets

**Visual do pet** bloqueia as aparências escolhidas. **Habilidade equipada** bloqueia as habilidades escolhidas, independentemente da aparência usada. Cada controle aparece quando a Lobbito fornece o catálogo correspondente para Contra Squad ou Battle Royale. A conferência da sala mostra qual regra cada jogador precisa atender antes da partida. [Catálogos e restrições da Lobbito](https://api.lobbito.com.br/docs#restricoes-sala)

## Iniciar, cancelar e acompanhar

- **Iniciar partida** envia o pedido à Lobbito. Os jogadores precisam estar presentes e prontos. Se houver uma lista de inscritos, eles precisam estar nos times definidos.
- **Cancelar sala** fecha uma sala que ainda está aguardando jogadores e libera a vaga simultânea. A criação continua contando na cota.
- **Acompanhar o resultado pela Lobbito** fica na configuração avançada. Para Contra Squad, cadastre os dois times. Em Battle Royale, o acompanhamento também pode ser solicitado sem inscrição prévia.

O portal atualiza a sala selecionada enquanto você estiver na página. Para consultar outra partida ou voltar a um resultado mais tarde, use **Ver sala** no histórico. Resultados confirmados mostram o vencedor e as estatísticas disponíveis. Quando a Lobbito sinaliza conferência, o portal mostra **Pendente**. [Documentação de resultados da Lobbito](https://api.lobbito.com.br/docs#resultado)

## Receber resultados direto da Lobbito

A aba **Resultados** reúne notificações `room.finished` e `room.result_pending` entregues ao servidor. Os resultados ficam disponíveis após fechar a página ou reiniciar o portal, desde que a hospedagem preserve o arquivo de dados. Cada conta vê as próprias notificações. O portal também consulta a API quando você abre a sala pelo histórico.

1. Hospede o portal em HTTPS, configure `PORTAL_ORIGIN` e conecte a chave da conta para consultar seu ID `acct_…` em **Resultados**.
2. Copie a URL exibida em **Configuração do webhook** e cadastre-a no painel da Lobbito. Ela usa o formato `https://seu-dominio/webhooks/lobbito/acct_…`.
3. Inclua o segredo `whsec_…` desse webhook em `LOBBITO_WEBHOOK_SECRETS` no ambiente do servidor. Use um segredo distinto por conta. O formato JSON é `{"acct_cliente01":"whsec_exemplo_substitua_pelo_segredo_real"}`.
4. Reinicie o portal com a configuração e use o botão de teste do webhook no painel da Lobbito. A aba **Resultados** mostra o horário em **Último teste recebido** quando o evento chega.

O servidor verifica a assinatura HMAC e o horário de cada entrega antes de gravá-la em SQLite. Reenvios com o mesmo identificador são reconhecidos, e uma notificação pendente que chega atrasada preserva o resultado já confirmado. A configuração e o segredo do webhook são independentes da chave de API usada para entrar no portal. [Documentação de webhooks da Lobbito](https://api.lobbito.com.br/docs#webhooks)

## Hospedar para clientes

Na ShardCloud, conecte o repositório GitHub. O manifesto `.shardcloud` inicia o serviço com Node.js 24. Configure a origem pública e use um volume persistente para SQLite. Em outros serviços Node.js, execute `npm start` atrás de um proxy HTTPS. Configure o proxy para aceitar respostas de pelo menos 60 segundos. O envio inicial à Lobbito tem limite de 50 segundos.

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP interna. Padrão `3080`. |
| `HOST` | Endereço de escuta. Padrão `127.0.0.1` local ou `0.0.0.0` quando a hospedagem define `PORT`. |
| `PORTAL_ORIGIN` | Origem pública exata, por exemplo `https://salas.example.com`. HTTPS ativa o atributo `Secure` no cookie. |
| `SECURE_COOKIES` | Defina `true` em produção para exigir cookie seguro. |
| `LOBBITO_WEBHOOK_SECRETS` | Objeto JSON com os IDs `acct_…` e seus segredos `whsec_…`. Configure quando quiser receber webhooks. |
| `RELEASE_SHA` | SHA completo da versão em pacotes sem metadados do Git. A rota `/health` expõe o commit e a hora de início da instância. |
| `LOBBITO_ATTEMPTS_DB` | Banco SQLite de protocolos pendentes. O padrão é `data/lobbito-attempts.sqlite`. Use um volume persistente. |
| `LOBBITO_WEBHOOK_DB` | Caminho para o banco SQLite de resultados. O padrão é `data/lobbito-results.sqlite`. Use um caminho em volume persistente na hospedagem. |

A chave da API fica em memória durante a sessão, que dura duas horas. O navegador recebe um cookie de sessão `HttpOnly` e `SameSite=Strict`. Os protocolos pendentes ficam em SQLite por conta, com o identificador do pedido e da sala quando disponível. Reiniciar a instância encerra as sessões. Depois de reconectar a chave, o cliente pode consultar o mesmo pedido.

## Verificar

```sh
npm run check
npm test
```

Os testes usam respostas simuladas e entregas assinadas para validar conexão, separação de contas, catálogo, histórico, criação pendente, idempotência, ações da sala, resultados e persistência de webhooks.

## Código deste portal

- `public/` contém a página, os estilos, as interações e a arte do cabeçalho.
- `server.mjs` serve a interface, mantém as sessões e chama as rotas públicas de conta, modos e salas da Lobbito.
- `lib/contract.mjs` valida as opções da sala e seleciona os dados públicos usados na interface.
- `lib/webhooks.mjs` valida as entregas assinadas e guarda notificações e resultados em SQLite.
- `test/` contém os testes de integração do portal.

## Arte do cabeçalho

`public/arena.jpg` foi criada para este portal com o gerador de imagens integrado. Prompt usado:

> Generate an original cinematic atmospheric landscape for the right side of a web dashboard hero banner for an esports custom lobby tool. Ultra wide composition, landscape 3:2 to be cropped by CSS to 2.5:1 through its center. No text, no branding, no watermark, no guns, no characters. Original setting: huge shadowed brutalist open-air esports arena hangar at night, tall triangular roof of blackened concrete partially visible, blue-cobalt light bars tracing a few architectural beams, glancing white-blue spot light and cool smoke, layered dark walls, an elevated walkway. Photoreal architectural visualization with subtle film grain and black shadows, sophisticated dark ultramarine rather than purple. Keep the left half especially dark and mostly empty with the strongest sparse white-blue accents on the right middle, so it gradients neatly into dark navy web UI. Wide planar view, high contrast, no lettering or panels.
