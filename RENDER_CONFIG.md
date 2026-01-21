# 🚀 Configuração de Deploy no Render

## Configurações do Web Service

### 1. Repository
```
https://github.com/ScriptsRemote/agroai_solos.git
```

### 2. Branch
```
main
```
ou
```
master
```

### 3. Root Directory
```
app_solo
```
⚠️ **Importante**: Se o repositório contém apenas o app_solo, deixe este campo vazio.

### 4. Build Command
```
npm install
```

### 5. Pre-Deploy Command (Opcional)
```
pip install -r requirements.txt
```
⚠️ **Nota**: O Render pode não suportar pip diretamente. Se der erro, você pode precisar:
- Usar um serviço separado para Python
- Ou instalar as dependências Python manualmente via script

### 6. Start Command
```
node server.js
```

### 7. Health Check Path
```
/healthz
```

## ⚙️ Environment Variables (Opcional)

Não são necessárias variáveis de ambiente obrigatórias, mas você pode adicionar:

- `NODE_ENV`: `production`

## 📝 Notas Importantes

1. **Python**: O Render precisa ter Python instalado. Se o build falhar ao instalar dependências Python, você pode precisar criar um serviço separado ou usar um buildpack Python.

2. **Porta**: O servidor está configurado para usar `process.env.PORT` automaticamente (porta fornecida pelo Render).

3. **Health Check**: O endpoint `/healthz` foi adicionado ao servidor para monitoramento.

4. **Arquivos Temporários**: Os diretórios `uploads/`, `output/` e `reports/` são criados automaticamente quando necessário.

## 🔄 Atualizar Configurações no Render

1. Acesse o dashboard do Render
2. Vá em **Settings** do seu serviço
3. Atualize os campos conforme acima
4. Clique em **Save Changes**
5. O Render fará um novo deploy automaticamente

## ✅ Checklist

- [ ] Repository atualizado para `agroai_solos`
- [ ] Branch configurada (`main` ou `master`)
- [ ] Root Directory configurado (se necessário)
- [ ] Build Command: `npm install`
- [ ] Start Command: `node server.js`
- [ ] Health Check Path: `/healthz`
- [ ] Servidor configurado para usar `process.env.PORT`
