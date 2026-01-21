# Mapa de Fertilidade do Solo

Aplicação web para análise e visualização de dados de fertilidade do solo através de interpolação espacial.

## 🚀 Deploy no Render

### Configuração do Web Service

1. **Repository**: `https://github.com/ScriptsRemote/agroai_solos.git`
2. **Branch**: `main` ou `master`
3. **Root Directory**: `app_solo` (se o repositório tiver outros projetos)

### Build & Deploy Settings

#### Build Command
```bash
npm install && pip install -r requirements.txt
```

Ou se o Render não suportar pip diretamente:
```bash
npm install
```

E adicione no **Pre-Deploy Command**:
```bash
pip install -r requirements.txt
```

#### Start Command
```bash
node server.js
```

#### Environment Variables (Opcional)
- `NODE_ENV`: `production`
- `PORT`: (gerenciado automaticamente pelo Render)

### Estrutura do Projeto

```
app_solo/
├── server.js              # Servidor Express.js
├── public/                # Frontend (HTML, CSS, JS)
│   ├── index.html
│   └── app.js
├── soil_interpolation.py  # Script Python para interpolação
├── generate_fertility_report.py  # Script Python para PDF
├── package.json          # Dependências Node.js
├── requirements.txt      # Dependências Python
└── bases/                # Arquivos de exemplo
```

### Dependências

#### Node.js (instaladas via npm)
- express
- multer
- csv-parser
- xlsx
- jszip
- shapefile
- proj4
- cors

#### Python (instaladas via pip)
- geopandas
- rasterio
- numpy
- pandas
- matplotlib
- reportlab
- pillow
- pykrige
- shapely

### Notas Importantes

1. **Python**: O Render precisa ter Python instalado. Verifique se o serviço suporta Python ou se precisa criar um serviço separado para os scripts Python.

2. **Porta**: O servidor está configurado para usar `process.env.PORT` (porta do Render) ou 3000 como fallback.

3. **Arquivos Temporários**: Os diretórios `uploads/`, `output/` e `reports/` são criados automaticamente.

4. **Health Check**: Configure o path `/healthz` ou crie uma rota de health check simples.

### Health Check Endpoint

Adicione no `server.js`:
```javascript
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

## 📦 Instalação Local

```bash
# Instalar dependências Node.js
npm install

# Instalar dependências Python
pip install -r requirements.txt

# Iniciar servidor
npm start
```

## 🔧 Funcionalidades

- Upload de planilhas (CSV/XLSX) e shapefiles (ZIP)
- Merge de dados geográficos
- Interpolação espacial (IDW e Krigagem)
- Visualização em mapas interativos (Leaflet)
- Geração de relatórios PDF profissionais
- Filtro por profundidade (coluna Prof do CSV)

## 📝 Licença

ISC
