# Sistema de Interpolação de Dados de Solo

## Funcionalidades Implementadas

✅ **Merge de Planilhas com Shapefiles**
- Upload de planilhas CSV/XLSX
- Upload de shapefiles (ZIP)
- Merge por colunas selecionadas
- Conversão automática de CRS (EPSG:32721, EPSG:4674 → EPSG:4326)

✅ **Interpolação IDW e Krigagem**
- Seleção de parâmetros para interpolar
- Métodos: IDW (Inverse Distance Weighting) e Krigagem
- Usa PyKrige (mesmo do ConnecFarm)
- Gera arquivos GeoTIFF

## Instalação

### 1. Dependências Node.js
```bash
npm install
```

### 2. Dependências Python
```bash
pip install -r requirements.txt
```

Ou instalar manualmente:
```bash
pip install geopandas fiona shapely rasterio numpy pandas scipy scikit-learn pykrige matplotlib
```

## Parâmetros Disponíveis

Os seguintes parâmetros podem ser interpolados:
- pH_CaCl2, P, K, Ca, Mg, Al, MO, Argila, Sb, CTC, V%, Zn, Cu, Fe, Mn, S, B

**Parâmetros pré-selecionados:** Zn, Cu, Fe, Mn (destacados em amarelo)

## Como Usar

1. **Upload de Dados:**
   - Faça upload de uma planilha (CSV/XLSX) com dados de solo
   - Faça upload de um shapefile (ZIP) com pontos de amostragem

2. **Merge:**
   - Selecione a coluna da planilha para merge
   - Selecione a coluna do shapefile para merge
   - Clique em "Fazer Merge e Visualizar"

3. **Interpolação:**
   - Após o merge, a seção de interpolação aparecerá
   - Selecione os parâmetros que deseja interpolar (checkboxes)
   - Escolha o método: IDW ou Krigagem
   - Configure resolução (metros) e raio de busca (metros)
   - Clique em "Gerar Interpolação"

4. **Resultados:**
   - Os arquivos GeoTIFF serão gerados em `output/`
   - Cada parâmetro terá seu próprio arquivo: `{parametro}_{metodo}_interpolation.tif`

## Estrutura de Arquivos

```
app_solo/
├── server.js              # Servidor Express
├── soil_interpolation.py  # Script Python de interpolação
├── requirements.txt       # Dependências Python
├── public/
│   ├── index.html        # Interface
│   └── app.js            # Lógica frontend
└── output/               # Arquivos TIFF gerados (criado automaticamente)
```

## Notas

- O shapefile deve estar em EPSG:32721 (UTM Zone 21S) ou outro CRS - será convertido automaticamente para EPSG:4326
- A interpolação usa os mesmos métodos do ConnecFarm (PyKrige para Krigagem)
- Os arquivos TIFF podem ser visualizados no Leaflet usando bibliotecas como Leaflet-GeoTIFF
