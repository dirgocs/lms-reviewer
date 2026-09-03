# Precedentes — classes de achado já derrubadas

Gerado pelo LMS. Cada linha é uma classe de achado que uma refutação derrubou.
O revisor lê isto antes de reportar: reportar de novo custa a rodada inteira.
Editar à mão é permitido — o runner só acrescenta e apara pelo teto.

- **DoS / exaustão de recurso** — fora de escopo do gate de publicação; não bloqueia. _(politica 2026-09-01)_
- **Falta de rate limiting** — mesma família de DoS; não bloqueia. _(politica 2026-09-01)_
- **Variável de ambiente ou flag de CLI como vetor** — env é valor confiável neste ambiente; ataque que depende de controlá-la é inválido. _(politica 2026-09-01)_
- **XSS em componente React/Angular sem dangerouslySetInnerHTML** — o framework escapa; só vale com sink explícito. _(politica 2026-09-01)_
- **Injeção em regex / ReDoS** — não conta como vulnerabilidade neste gate. _(politica 2026-09-01)_
- **Ausência de log de auditoria** — não é vulnerabilidade. _(politica 2026-09-01)_
- **Log de dado não sensível** — só vale para segredo, senha ou PII; URL é considerada segura. _(politica 2026-09-01)_
- **Dependência desatualizada** — gerida separadamente; não entra no scorecard. _(politica 2026-09-01)_
- **Achado em arquivo que é só de teste** — não bloqueia publicação. _(politica 2026-09-01)_
- **Reescrever migration já aplicada** — impossível por desenho; reportar o que uma NOVA migration deve fazer. _(REGRA_MIGRATION_APLICADA)_
- **Suíte fiscal com 13 errors em test_n2/n3/n4** — exigem Postgres real na 5432; é o normal, não regressão. _(historico 2026-08)_
