# FF-Salas-API

Portal web em português para organizar salas personalizadas de Free Fire pela API pública da Lobbito. Crie treinos e partidas com regras de habilidades, compartilhe o acesso e acompanhe os resultados no mesmo painel. Cada organizador usa a chave e a cota da sua conta. [Conheça a Lobbito API](https://api.lobbito.com.br/) · [Documentação oficial](https://api.lobbito.com.br/docs)

- Crie salas de Contra Squad ou Battle Royale e compartilhe o ID e a senha com os jogadores.
- Bloqueie habilidades ativas e passivas de personagens escolhidos e veja quem precisa ajustar as habilidades antes da partida.
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
3. Em **Bloqueio de personagens**, busque e marque as habilidades que devem ficar fora da partida. O restante do catálogo fica liberado. Em **Opções avançadas**, ajuste as outras regras ou cadastre os jogadores para ativar o início automático.
4. Clique em **Criar sala**. Quando a Lobbito confirmar a criação, copie o ID e a senha para compartilhar com os jogadores.

O **Histórico de salas** consulta as salas da conta diretamente na API. Cada sessão acompanha um pedido de criação por vez até a confirmação. Se a conexão cair antes da confirmação, **Verificar pedido** reenvia a mesma configuração com o mesmo identificador de idempotência. Essa recuperação está disponível durante a mesma sessão do portal. Após expirar, desconectar ou reiniciar o servidor, consulte o histórico da conta antes de enviar outro pedido.

## Bloqueio de personagens

Disponível em Contra Squad e Battle Royale. A seleção usa o catálogo da Lobbito e vale para as habilidades ativas e passivas que os jogadores equiparem. A aparência do personagem no jogo continua livre. Ao usar a regra, deixe pelo menos um personagem liberado. A Lobbito confere as habilidades antes do início e o portal mostra os IDs dos jogadores que precisam ajustar a seleção. [Regras de criação e início da Lobbito](https://api.lobbito.com.br/docs#criar-sala)

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

Execute `npm start` em um serviço Node.js persistente atrás de um proxy HTTPS. Configure o proxy para aceitar respostas de pelo menos 60 segundos. O envio inicial à Lobbito tem limite de 50 segundos.

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP interna. Padrão `3080`. |
| `HOST` | Endereço de escuta. Padrão `127.0.0.1`. Use `0.0.0.0` se a plataforma encaminhar as solicitações por rede interna. |
| `PORTAL_ORIGIN` | Origem pública exata, por exemplo `https://salas.example.com`. HTTPS ativa o atributo `Secure` no cookie. |
| `SECURE_COOKIES` | Defina `true` em produção para exigir cookie seguro. |
| `LOBBITO_WEBHOOK_SECRETS` | Objeto JSON com os IDs `acct_…` e seus segredos `whsec_…`. Configure quando quiser receber webhooks. |
| `LOBBITO_WEBHOOK_DB` | Caminho para o banco SQLite de resultados. O padrão é `data/lobbito-results.sqlite`. Use um caminho em volume persistente na hospedagem. |

Provisione uma instância persistente. A chave e o pedido pendente ficam na memória da instância durante a sessão, que dura duas horas. O navegador recebe um cookie de sessão `HttpOnly` e `SameSite=Strict`. Em uma hospedagem compartilhada, limite o acesso administrativo e mantenha logs do proxy sem cabeçalhos de autenticação, cookies ou corpos das solicitações. Reiniciar a instância encerra as sessões, e os clientes podem reconectar suas chaves.

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
