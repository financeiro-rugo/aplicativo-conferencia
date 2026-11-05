# Conferência de Carga para o computador da empresa

Aplicativo que roda no navegador (Chrome ou Edge), sem instalar nada e sem servidor.

- **Senha de acesso:** uma senha só para abrir o aplicativo.
- **Conferente:** antes de iniciar, a pessoa escreve o próprio nome. O nome fica gravado na carga e aparece no relatório.
- **Conferência por cliente:** anexa a guia de entrega em PDF; o app separa por cliente (com as notas fiscais, sem pontos: 2.179.141 vira 2179141). Você escolhe **só o cliente que vai conferir**; dentro dele, escolhe o produto, tira a foto e digita a quantidade. O app **não aceita quantidade maior que a da ordem** e mostra **quanto falta**.
- **Relatório:** lista as cargas por dia ou período, filtra por conferente, mostra as fotos e baixa a planilha.
- **Cópia de segurança:** baixa e restaura todos os dados (com as fotos).

## Como usar

1. Descompacte a pasta `conferencia-pc` no computador (por exemplo em `Documentos`).
2. Dê dois cliques em **`index.html`**. Abre no navegador.
3. No primeiro acesso, **crie a senha**. Depois é só digitar a senha.
4. Dica: no Chrome ou Edge, clique em **Favoritos** e salve a página, ou crie um atalho na área de trabalho para o `index.html`.

## Dia a dia

1. Na tela inicial, escreva o **nome do conferente**.
2. Anexe o **PDF da guia de entrega** (o app lê clientes, notas e produtos; confira antes de iniciar, o app avisa se a contagem não bate com o "Total Itens" do PDF) ou cadastre na mão.
3. Toque em **Iniciar conferência**, abra cada produto, **escolha a foto** (no computador, escolha um arquivo de imagem; em celular ou notebook com câmera, abre a câmera) e digite a quantidade.
4. Ao terminar, **Finalizar e salvar carga**. A carga vai para o relatório.
5. Em **Relatório do dia**, escolha **De / Até** (e o conferente, se quiser) e toque em **Baixar planilha**.

## Ler PDF e gerar .xlsx

- Com internet, o app baixa sozinho as ferramentas para **ler o PDF** e gerar a planilha em **.xlsx**.
- Sem internet, coloque 3 arquivos na pasta `libs` (veja `libs/LEIA-ME.txt`). É só baixar uma vez.
- Sem internet e sem esses arquivos: digite os produtos na mão e a planilha sai em **.csv**, que o Excel abre normalmente.

## Onde ficam os dados (importante)

Os dados ficam guardados **dentro do navegador deste computador**. Isso significa:

- Use sempre o **mesmo navegador e o mesmo computador**. Outro computador começa vazio.
- **Limpar os dados de navegação apaga tudo.** Faça a cópia de segurança com frequência: **Ajustes > Baixar cópia de segurança** e guarde o arquivo em outro lugar (pen drive, rede ou nuvem).
- Para levar os dados para outro computador: baixe a cópia no primeiro e use **Restaurar uma cópia** no segundo.
- Se precisar que vários computadores ou celulares compartilhem os mesmos dados, existe a versão com banco de dados na nuvem (pasta `conferencia-app`, com Supabase).

## Senha

- A senha protege a **tela de entrada**. Ela **não criptografa** os dados do navegador. Serve para impedir que alguém use o app sem querer, mas não substitui a proteção do computador.
- Trocar a senha: **Ajustes > Trocar senha**.
- **Esqueceu a senha?** Sem perder os dados: abra o app, aperte **F12**, vá na aba **Console**, digite `localStorage.removeItem('conferencia-senha-v1')` e aperte Enter. Recarregue a página: ele pede para criar uma senha nova.

## Editar o aplicativo depois

São só 3 arquivos de texto, que abrem em qualquer editor (Bloco de Notas, VS Code):

| Arquivo | O que muda |
|---|---|
| `style.css` | cores, fontes, tamanhos |
| `app.js` | todo o comportamento (a lógica de conferência, a regra de quantidade, o relatório, as colunas da planilha) |
| `index.html` | estrutura da página e carregamento das ferramentas |

Salve e recarregue a página (Ctrl+F5) para ver a mudança. O `app.js` é dividido por comentários do tipo `/* ---------- ... ---------- */`:

- **Colunas da planilha:** função `downloadSheet`.
- **Regra de quantidade:** função `validate`.
- **Campos novos** (placa, motorista): acrescente o campo em `renderSetup`, guarde em `S` e inclua em `buildRecord`.

Os dados já salvos continuam funcionando quando você muda o código. Faça uma cópia de segurança antes de mudanças grandes. Se quiser, me mande os arquivos e diga o que alterar.

## Cuidados

- Funciona melhor no **Chrome** ou **Edge** atualizados.
- Se o PDF não for lido, o app avisa e você digita os produtos. PDF escaneado (imagem) não tem texto para ler.
- Um mesmo navegador pode guardar milhares de cargas, mas as fotos ocupam espaço. Baixe a cópia de segurança de tempos em tempos.

## Guia de entrega por cliente

- Nesta guia (modelo Mili eFrotas) os produtos pertencem ao **cliente**, não a cada nota. Por isso cada cliente mostra todas as suas notas e uma lista única de produtos.
- A guia não traz **unidade** (UN, CX...). O campo fica vazio e pode ser preenchido na edição. Nada é inventado.
- O texto de observação da guia é lido como está.
- O relatório e a planilha saem agrupados por cliente, com a coluna **Notas fiscais**.
- Cargas salvas antes desta versão continuam aparecendo no relatório.

## Relatórios (botão "Relatórios")

- **Conferências feitas:** as conferências que você salvou, por período e por conferente, com planilha.
- **Situação por cliente:** todos os clientes da guia, mostrando quem **falta conferir**, quem foi **conferido** e quem foi conferido **com falta**, com os produtos de cada um. Tem filtro e planilha (abas "Resumo por cliente" e "Produtos").
- A guia fica salva neste computador assim que o PDF é lido. Para continuar outro dia, use "Guias salvas neste computador". Conferir um cliente de novo substitui a situação anterior dele.
- A cópia de segurança (Ajustes) inclui as guias e as conferências.
