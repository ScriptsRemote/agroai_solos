const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const yauzl = require('yauzl');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { promisify } = require('util');
const { spawn } = require('child_process');

// Carregar bibliotecas de shapefile
let shapefileLib = null;
let shpjsLib = null;
let proj4 = null;
let reproject = null;

try {
  shapefileLib = require('shapefile');
} catch (e) {
  console.warn('shapefile.js não disponível, usando shpjs como alternativa');
}

try {
  shpjsLib = require('shpjs');
} catch (e) {
  console.warn('shpjs não disponível');
}

try {
  proj4 = require('proj4');
  // Registrar definições de CRS
  proj4.defs('EPSG:4674', '+proj=longlat +ellps=GRS80 +no_defs +type=crs');
  proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
  // UTM Zone 21S (EPSG:32721) - WGS 84 / UTM zone 21S
  proj4.defs('EPSG:32721', '+proj=utm +zone=21 +south +datum=WGS84 +units=m +no_defs +type=crs');
  console.log('proj4 carregado com suporte a SIRGAS 2000 (EPSG:4674) e UTM Zone 21S (EPSG:32721)');
} catch (e) {
  console.warn('proj4 não disponível:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// IMPORTANTE: Rotas de API devem vir ANTES do express.static
// app.use(express.static('public')); // Movido para o final

// Configuração do multer para upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Função para extrair ZIP
function extractZip(zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // É um diretório
          const dirPath = path.join(extractPath, entry.fileName);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          zipfile.readEntry();
        } else {
          // É um arquivo
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);
            
            const filePath = path.join(extractPath, entry.fileName);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            
            const writeStream = fs.createWriteStream(filePath);
            readStream.pipe(writeStream);
            readStream.on('end', () => {
              zipfile.readEntry();
            });
          });
        }
      });

      zipfile.on('end', () => {
        resolve(extractPath);
      });

      zipfile.on('error', reject);
    });
  });
}

// Função para reprojetar GeoJSON de um CRS para outro
function reprojectGeoJSON(geojson, fromCRS, toCRS = 'EPSG:4326') {
  if (!proj4) {
    console.warn('proj4 não disponível, pulando reprojeção');
    return geojson;
  }

  // Se já está no CRS de destino, não precisa reprojetar
  if (fromCRS === toCRS || (fromCRS === 'EPSG:4326' || fromCRS === '4326')) {
    return geojson;
  }

  // Criar função de transformação usando proj4
  let transform;
  try {
    // UTM Zone 21S (EPSG:32721) para WGS84 (EPSG:4326)
    if (fromCRS === 'EPSG:32721' || fromCRS === '32721') {
      console.log('Convertendo de UTM Zone 21S (EPSG:32721) para WGS84 (EPSG:4326)');
      transform = proj4('EPSG:32721', 'EPSG:4326');
    }
    // Outras zonas UTM
    else if (fromCRS.startsWith('EPSG:327') || fromCRS.startsWith('EPSG:326')) {
      console.log(`Convertendo de UTM ${fromCRS} para WGS84 (EPSG:4326)`);
      transform = proj4(fromCRS, 'EPSG:4326');
    }
    // SIRGAS 2000 para WGS84
    else if (fromCRS === 'EPSG:4674' || fromCRS === '4674') {
      console.log('Convertendo de SIRGAS 2000 (EPSG:4674) para WGS84 (EPSG:4326)');
      transform = proj4('EPSG:4674', 'EPSG:4326');
    } else if (fromCRS === 'UTM' || fromCRS === 'PROJECTED') {
      // Tentar detectar UTM do primeiro ponto
      console.warn('CRS projetado detectado mas não identificado, tentando usar proj4 diretamente');
      // Se shpjs já fez a conversão usando o .prj, pode não precisar reprojetar
      return geojson;
    } else {
      console.warn(`CRS ${fromCRS} não suportado, tentando conversão direta com proj4`);
      // Tentar conversão direta
      transform = proj4(fromCRS, toCRS);
    }
  } catch (error) {
    console.warn(`Erro ao criar transformação de ${fromCRS} para ${toCRS}: ${error.message}`);
    // Se falhar, tentar usar o proj4 diretamente com o código EPSG
    try {
      console.log('Tentando conversão direta com proj4...');
      transform = proj4(fromCRS, toCRS);
    } catch (error2) {
      console.error(`Tentativa alternativa também falhou: ${error2.message}`);
      return geojson;
    }
  }

  // Função recursiva para reprojetar coordenadas
  function transformCoordinates(coords) {
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      // É uma coordenada [x, y] - pode ser [lon, lat] em graus ou [easting, northing] em metros UTM
      try {
        const x = coords[0];
        const y = coords[1];
        
        // Verificar apenas se não é NaN
        if (isNaN(x) || isNaN(y)) {
          console.warn(`Coordenada com NaN: [${x}, ${y}]`);
          return coords;
        }
        
        // IMPORTANTE: Para UTM, as coordenadas estão em [easting, northing] (metros)
        // proj4.forward para UTM espera [easting, northing] e retorna [lon, lat]
        // UTM: [easting (x), northing (y)] -> WGS84: [longitude, latitude]
        const transformed = transform.forward([x, y]);
        
        // Verificar resultado
        if (isNaN(transformed[0]) || isNaN(transformed[1])) {
          console.warn(`Transformação resultou em NaN para [${x}, ${y}]`);
          return coords;
        }
        
        // proj4 retorna [lon, lat] para conversões de UTM para geográfico
        // GeoJSON sempre usa [lon, lat], então está correto
        const lon = transformed[0];
        const lat = transformed[1];
        
        // Validação: longitude deve estar entre -180 e 180, latitude entre -90 e 90
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
          console.error(`⚠️ Coordenada transformada fora do range válido: [${lon}, ${lat}]`);
          console.error(`   Coordenada original (UTM): [${x}, ${y}]`);
          // Se estiver invertido, tentar inverter
          if (Math.abs(transformed[1]) > 180 || Math.abs(transformed[0]) > 90) {
            console.log('   Tentando inverter coordenadas...');
            return [lat, lon]; // Inverter se necessário
          }
        }
        
        // Retornar [lon, lat] em graus (resultado da transformação)
        return [lon, lat];
      } catch (error) {
        console.warn(`Erro ao transformar coordenada [${coords[0]}, ${coords[1]}]: ${error.message}`);
        return coords;
      }
    } else if (Array.isArray(coords)) {
      // É um array de coordenadas (pode ser nested)
      return coords.map(coord => transformCoordinates(coord));
    }
    return coords;
  }

  // Reprojetar cada feature
  const reprojectedFeatures = geojson.features.map(feature => {
    if (!feature.geometry || !feature.geometry.coordinates) {
      return feature;
    }

    try {
      const newFeature = {
        ...feature,
        geometry: {
          ...feature.geometry,
          coordinates: transformCoordinates(feature.geometry.coordinates)
        }
      };
      return newFeature;
    } catch (error) {
      console.warn(`Erro ao reprojetar feature: ${error.message}`);
      return feature;
    }
  });

  return {
    ...geojson,
    features: reprojectedFeatures
  };
}

// Função para detectar CRS do shapefile
function detectCRS(prjString) {
  if (!prjString) {
    // Se não há arquivo .prj, assumir SIRGAS 2000 (EPSG:4674) como padrão
    return 'EPSG:4674';
  }

  // Verificar se é UTM (projeção projetada)
  if (prjString.includes('UTM') || prjString.includes('Transverse_Mercator')) {
    // Extrair zona UTM se possível
    const zoneMatch = prjString.match(/Zone[_\s]*(\d+)([NS])/i);
    if (zoneMatch) {
      const zone = parseInt(zoneMatch[1]);
      const hemisphere = zoneMatch[2].toUpperCase();
      // UTM Zone 21S = EPSG:32721, Zone 21N = EPSG:32621
      const epsgCode = hemisphere === 'S' ? 32700 + zone : 32600 + zone;
      console.log(`UTM detectado: Zone ${zone}${hemisphere} = EPSG:${epsgCode}`);
      return `EPSG:${epsgCode}`;
    }
    // Verificar se menciona especificamente Zone 21S
    if (prjString.includes('Zone_21S') || prjString.includes('Zone 21S')) {
      console.log('UTM Zone 21S detectado diretamente = EPSG:32721');
      return 'EPSG:32721';
    }
    // Se não conseguir extrair, retornar genérico
    console.warn('UTM detectado mas zona não identificada');
    return 'UTM';
  }

  // Verificar se é SIRGAS 2000
  if (prjString.includes('SIRGAS') || prjString.includes('4674') || prjString.includes('GCS_SIRGAS2000')) {
    return 'EPSG:4674';
  }

  // Verificar se é WGS84 geográfico
  if ((prjString.includes('WGS84') || prjString.includes('4326') || prjString.includes('GCS_WGS_1984')) 
      && !prjString.includes('UTM') && !prjString.includes('PROJCS')) {
    return 'EPSG:4326';
  }

  // Se tem PROJCS, é uma projeção projetada (não geográfica)
  if (prjString.includes('PROJCS')) {
    return 'PROJECTED';
  }

  // Por padrão, assumir SIRGAS 2000 para dados brasileiros
  return 'EPSG:4674';
}

// Função para ler shapefile
async function readShapefile(shpPath, targetCRS = 'EPSG:4326') {
  // Tentar usar shapefile.js primeiro
  if (shapefileLib) {
    try {
      const source = await shapefileLib.open(shpPath);
      const features = [];
      
      let result = await source.read();
      while (!result.done) {
        features.push(result.value);
        result = await source.read();
      }
      
      return {
        type: 'FeatureCollection',
        features: features
      };
    } catch (error) {
      console.warn('Erro ao usar shapefile.js, tentando shpjs:', error.message);
    }
  }
  
  // Se shapefile.js não estiver disponível ou falhar, tentar com shpjs
  if (shpjsLib) {
    try {
      const shpBuffer = fs.readFileSync(shpPath);
      const dbfPath = shpPath.replace(/\.shp$/i, '.dbf');
      
      // Verificar se há arquivo .prj para projeção
      const prjPath = shpPath.replace(/\.shp$/i, '.prj');
      let prjString = undefined;
      if (fs.existsSync(prjPath)) {
        prjString = fs.readFileSync(prjPath, 'utf8');
        console.log('Arquivo .prj encontrado:', prjString.substring(0, 100) + '...');
      } else {
        console.warn('Arquivo .prj não encontrado, assumindo CRS padrão');
      }
      
      // Verificar se há arquivo .cpg para encoding
      const cpgPath = shpPath.replace(/\.shp$/i, '.cpg');
      let cpgEncoding = undefined;
      if (fs.existsSync(cpgPath)) {
        cpgEncoding = fs.readFileSync(cpgPath, 'utf8').trim();
      }
      
      let featureCollection;
      
      // IMPORTANTE: Para UTM, NÃO passar prjString para shpjs.parseShp
      // Vamos ler as coordenadas em UTM (metros) e converter manualmente com proj4
      // Isso garante controle total sobre a conversão
      
      // Detectar CRS ANTES de ler o shapefile
      const detectedCRS = detectCRS(prjString);
      console.log(`\n📋 CRS detectado ANTES da leitura: ${detectedCRS}`);
      
      // Se for UTM ou projeção projetada, NÃO passar prjString para manter coordenadas em metros
      // Se for geográfico, passar prjString para manter em graus
      let usePrjForConversion = false;
      if (detectedCRS === 'EPSG:4326' || detectedCRS === 'EPSG:4674') {
        usePrjForConversion = true;
        console.log('✓ CRS geográfico detectado, shpjs pode usar .prj');
      } else {
        console.log('⚠️ CRS projetado (UTM) detectado, lendo coordenadas em metros e convertendo manualmente');
      }
      
      if (fs.existsSync(dbfPath)) {
        const dbfBuffer = fs.readFileSync(dbfPath);
        
        // Se for geográfico, passar prjString. Se for UTM, NÃO passar (null)
        const geometries = usePrjForConversion 
          ? shpjsLib.parseShp(shpBuffer, prjString)
          : shpjsLib.parseShp(shpBuffer, null); // null = não converter, manter em metros UTM
        const properties = shpjsLib.parseDbf(dbfBuffer, cpgEncoding);
        
        // Combinar em FeatureCollection
        featureCollection = shpjsLib.combine([geometries, properties]);
      } else {
        // Apenas .shp sem .dbf
        const geometries = usePrjForConversion 
          ? shpjsLib.parseShp(shpBuffer, prjString)
          : shpjsLib.parseShp(shpBuffer, null);
        
        const features = geometries.map(geom => ({
          type: 'Feature',
          geometry: geom,
          properties: {}
        }));
        
        featureCollection = {
          type: 'FeatureCollection',
          features: features
        };
      }
      
      console.log(`Total de features: ${featureCollection.features.length}`);
      
      // Log de coordenadas ANTES de qualquer processamento
      if (featureCollection.features.length > 0) {
        const firstFeature = featureCollection.features[0];
        if (firstFeature.geometry && firstFeature.geometry.coordinates) {
          const coords = firstFeature.geometry.type === 'Point' 
            ? firstFeature.geometry.coordinates 
            : firstFeature.geometry.coordinates[0];
          console.log(`\n📍 Primeira coordenada (após shpjs): [${coords[0]}, ${coords[1]}]`);
          
          // Se as coordenadas estão em metros (UTM), valores serão grandes (ex: 500000, 7500000)
          // Se estão em graus, valores serão pequenos (ex: -57.0, -22.9)
          if (Math.abs(coords[0]) > 1000 || Math.abs(coords[1]) > 1000) {
            console.log('   → Coordenadas parecem estar em METROS (UTM), precisa converter!');
            console.log(`   → Formato: [easting (x), northing (y)] em metros`);
          } else {
            console.log('   → Coordenadas parecem estar em GRAUS (geográfico)');
            console.log(`   → Formato: [longitude, latitude] em graus`);
          }
          
          // Log de algumas coordenadas para análise
          if (featureCollection.features.length > 5) {
            console.log(`\n   Exemplos de coordenadas (primeiras 5):`);
            for (let i = 0; i < Math.min(5, featureCollection.features.length); i++) {
              const feat = featureCollection.features[i];
              if (feat.geometry && feat.geometry.coordinates) {
                const c = feat.geometry.type === 'Point' 
                  ? feat.geometry.coordinates 
                  : feat.geometry.coordinates[0];
                console.log(`     Feature ${i+1}: [${c[0]}, ${c[1]}]`);
              }
            }
          }
        }
      }
      
      // SEMPRE reprojetar se o CRS detectado não for geográfico (WGS84 ou SIRGAS 2000)
      // Isso garante que UTM seja convertido para WGS84
      if (detectedCRS !== 'EPSG:4326' && detectedCRS !== 'EPSG:4674') {
        console.log(`\n🔄 REPROJEÇÃO NECESSÁRIA:`);
        console.log(`   De: ${detectedCRS} (projeção projetada/UTM)`);
        console.log(`   Para: ${targetCRS} (geográfico para Leaflet)`);
        
        // Log de exemplo de coordenadas ANTES da reprojeção
        if (featureCollection.features.length > 0) {
          const firstFeature = featureCollection.features[0];
          if (firstFeature.geometry && firstFeature.geometry.coordinates) {
            const coords = firstFeature.geometry.type === 'Point' 
              ? firstFeature.geometry.coordinates 
              : firstFeature.geometry.coordinates[0];
            console.log(`   Coordenada exemplo (ANTES - em metros UTM): [${coords[0]}, ${coords[1]}]`);
          }
        }
        
        // Fazer a reprojeção
        featureCollection = reprojectGeoJSON(featureCollection, detectedCRS, targetCRS);
        
        // Log de exemplo de coordenadas DEPOIS da reprojeção
        if (featureCollection.features.length > 0) {
          console.log(`\n   Exemplos de coordenadas APÓS conversão (primeiras 5):`);
          for (let i = 0; i < Math.min(5, featureCollection.features.length); i++) {
            const feat = featureCollection.features[i];
            if (feat.geometry && feat.geometry.coordinates) {
              const coords = feat.geometry.type === 'Point' 
                ? feat.geometry.coordinates 
                : feat.geometry.coordinates[0];
              console.log(`     Feature ${i+1}: [${coords[0]}, ${coords[1]}]`);
              
              // Validar se a conversão funcionou
              if (i === 0) {
                if (Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90) {
                  console.log(`     ✓ Coordenadas em formato geográfico válido [lon, lat]`);
                } else {
                  console.error(`     ✗ ERRO: Coordenadas fora do range válido!`);
                  console.error(`        Esperado: lon [-180, 180], lat [-90, 90]`);
                  console.error(`        Recebido: [${coords[0]}, ${coords[1]}]`);
                }
              }
            }
          }
          
          // Verificar se todas as coordenadas estão válidas
          let validCount = 0;
          let invalidCount = 0;
          featureCollection.features.forEach(feat => {
            if (feat.geometry && feat.geometry.coordinates) {
              const coords = feat.geometry.type === 'Point' 
                ? feat.geometry.coordinates 
                : feat.geometry.coordinates[0];
              if (Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90) {
                validCount++;
              } else {
                invalidCount++;
              }
            }
          });
          console.log(`\n   Validação: ${validCount} válidas, ${invalidCount} inválidas de ${featureCollection.features.length} total`);
        }
      } else if (detectedCRS === 'EPSG:4674' && targetCRS === 'EPSG:4326') {
        // SIRGAS 2000 para WGS84 (diferença mínima, mas vamos fazer)
        console.log(`\n🔄 Convertendo de SIRGAS 2000 (EPSG:4674) para WGS84 (EPSG:4326)`);
        featureCollection = reprojectGeoJSON(featureCollection, detectedCRS, targetCRS);
      } else {
        console.log(`✓ CRS já está em formato geográfico (${detectedCRS}), não precisa reprojetar`);
      }
      
      return featureCollection;
    } catch (error) {
      throw new Error(`Erro ao ler shapefile com shpjs: ${error.message}`);
    }
  }
  
  throw new Error('Nenhuma biblioteca de shapefile disponível. Instale shapefile ou shpjs.');
}

// Função para encontrar arquivo .shp em um diretório
function findShpFile(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      const found = findShpFile(filePath);
      if (found) return found;
    } else if (file.toLowerCase().endsWith('.shp')) {
      return filePath;
    }
  }
  return null;
}

// Função para encontrar diretório base do shapefile (onde estão todos os arquivos)
function findShapefileDir(shpPath) {
  return path.dirname(shpPath);
}

// Endpoint para upload de planilha
app.post('/api/upload-spreadsheet', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let data = [];
    let columns = [];

    if (fileExt === '.csv') {
      // Ler CSV
      const results = [];
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => results.push(row))
          .on('end', () => {
            data = results;
            if (results.length > 0) {
              columns = Object.keys(results[0]);
            }
            resolve();
          })
          .on('error', reject);
      });
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      // Ler XLSX
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      data = xlsx.utils.sheet_to_json(worksheet);
      if (data.length > 0) {
        columns = Object.keys(data[0]);
      }
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Formato de arquivo não suportado. Use CSV ou XLSX.' });
    }

    res.json({
      success: true,
      data: data,
      columns: columns,
      filename: req.file.originalname
    });
  } catch (error) {
    console.error('Erro ao processar planilha:', error);
    res.status(500).json({ error: 'Erro ao processar planilha: ' + error.message });
  }
});

// Endpoint para upload de shapefile (ZIP)
app.post('/api/upload-shapefile', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    if (fileExt !== '.zip') {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'O shapefile deve estar em um arquivo ZIP' });
    }

    // Extrair ZIP e ler shapefile usando a mesma abordagem do ConnecFarm
    const JSZip = require('jszip');
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(fs.readFileSync(filePath));
    
    let shpBuffer, dbfBuffer, prjString = null;
    
    // Extrair arquivos do ZIP
    for (const [filename, file] of Object.entries(zipContent.files)) {
      if (filename.endsWith('.shp')) {
        shpBuffer = await file.async('nodebuffer');
        console.log(`📦 Arquivo .shp encontrado: ${filename}`);
      } else if (filename.endsWith('.dbf')) {
        dbfBuffer = await file.async('nodebuffer');
        console.log(`📦 Arquivo .dbf encontrado: ${filename}`);
      } else if (filename.endsWith('.prj')) {
        prjString = await file.async('string');
        console.log(`📦 Arquivo .prj encontrado: ${filename}`);
        console.log(`   Conteúdo .prj: ${prjString.substring(0, 150)}...`);
      }
    }
    
    if (!shpBuffer) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Arquivo .shp não encontrado no ZIP' });
    }
    
    if (!dbfBuffer) {
      console.warn('⚠️ Arquivo .dbf não encontrado, continuando apenas com .shp');
    }
    
    // Detectar CRS do arquivo .prj
    let detectedCRS = 'EPSG:4326'; // Padrão
    if (prjString) {
      detectedCRS = detectCRS(prjString);
      console.log(`\n📋 CRS detectado do arquivo .prj: ${detectedCRS}`);
    } else {
      console.warn('⚠️ Arquivo .prj não encontrado no ZIP, assumindo WGS84 (EPSG:4326)');
    }
    
    // Usar shapefile.js para ler o shapefile
    if (!shapefileLib) {
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'Biblioteca shapefile.js não disponível' });
    }
    
    console.log('📂 Lendo shapefile com shapefile.js');
    const source = await shapefileLib.open(shpBuffer, dbfBuffer);
    const features = [];
    
    let result;
    while ((result = await source.read()) && !result.done) {
      features.push(result.value);
    }
    
    if (features.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Nenhuma feature encontrada no shapefile' });
    }
    
    console.log(`✅ ${features.length} features lidas com shapefile.js`);
    
    // Criar GeoJSON temporário para validação
    let geojson = {
      type: 'FeatureCollection',
      features: features
    };
    
    // Log de exemplo de coordenadas ANTES da conversão
    if (geojson.features.length > 0) {
      const firstFeature = geojson.features[0];
      if (firstFeature.geometry && firstFeature.geometry.coordinates) {
        const coords = firstFeature.geometry.type === 'Point' 
          ? firstFeature.geometry.coordinates 
          : firstFeature.geometry.coordinates[0];
        console.log(`📍 Primeira coordenada (após shapefile.js): [${coords[0]}, ${coords[1]}]`);
        
        // Verificar se precisa conversão
        const needsConversion = Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90;
        
        if (needsConversion) {
          console.warn(`   ⚠️ Coordenadas fora do range geográfico!`);
          console.warn(`   → Provavelmente ainda em CRS original (${detectedCRS})`);
          console.warn(`   → shapefile.js pode não ter convertido automaticamente`);
        } else {
          console.log(`   ✓ Coordenadas parecem estar em formato geográfico [lon, lat]`);
        }
      }
    }
    
    // SEMPRE converter para EPSG:4326 se não estiver já nesse CRS
    if (detectedCRS !== 'EPSG:4326' && detectedCRS !== 'EPSG:4674') {
      console.log(`\n🔄 CONVERSÃO NECESSÁRIA para EPSG:4326 (Leaflet):`);
      console.log(`   De: ${detectedCRS}`);
      console.log(`   Para: EPSG:4326 (WGS84)`);
      
      // Fazer conversão manual com proj4
      geojson = reprojectGeoJSON(geojson, detectedCRS, 'EPSG:4326');
      
      // Validar coordenadas após conversão
      if (geojson.features.length > 0) {
        const firstFeature = geojson.features[0];
        if (firstFeature.geometry && firstFeature.geometry.coordinates) {
          const coords = firstFeature.geometry.type === 'Point' 
            ? firstFeature.geometry.coordinates 
            : firstFeature.geometry.coordinates[0];
          console.log(`📍 Primeira coordenada (após conversão): [${coords[0]}, ${coords[1]}]`);
          
          if (Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90) {
            console.log(`   ✓ Conversão bem-sucedida! Coordenadas em EPSG:4326 [lon, lat]`);
          } else {
            console.error(`   ✗ ERRO: Coordenadas ainda inválidas após conversão!`);
          }
        }
      }
    } else if (detectedCRS === 'EPSG:4674') {
      // SIRGAS 2000 para WGS84 (diferença mínima, mas vamos converter)
      console.log(`\n🔄 Convertendo de SIRGAS 2000 (EPSG:4674) para WGS84 (EPSG:4326)`);
      geojson = reprojectGeoJSON(geojson, 'EPSG:4674', 'EPSG:4326');
    } else {
      console.log(`✓ CRS já está em WGS84 (EPSG:4326), pronto para Leaflet`);
    }

    // Extrair colunas dos atributos
    let columns = [];
    if (geojson.features.length > 0 && geojson.features[0].properties) {
      columns = Object.keys(geojson.features[0].properties);
    }

    // Limpar arquivo temporário
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      geojson: geojson,
      columns: columns,
      filename: req.file.originalname
    });
  } catch (error) {
    console.error('Erro ao processar shapefile:', error);
    res.status(500).json({ error: 'Erro ao processar shapefile: ' + error.message });
  }
});

// Endpoint para fazer merge
app.post('/api/merge', async (req, res) => {
  try {
    const { spreadsheetData, shapefileGeoJson, spreadsheetColumn, shapefileColumn, selectedDepth } = req.body;

    if (!spreadsheetData || !shapefileGeoJson || !spreadsheetColumn || !shapefileColumn) {
      return res.status(400).json({ error: 'Dados incompletos para merge' });
    }

    console.log(`\n🔄 Iniciando merge...`);
    console.log(`   Coluna da planilha: ${spreadsheetColumn}`);
    console.log(`   Coluna do shapefile: ${shapefileColumn}`);
    console.log(`   Profundidade selecionada (CSV): ${selectedDepth || 'Nenhuma'}`);
    console.log(`   Registros na planilha: ${spreadsheetData.length}`);
    console.log(`   Features no shapefile: ${shapefileGeoJson.features.length}`);

    // Filtrar dados por profundidade se selecionada
    let filteredSpreadsheetData = spreadsheetData;
    let filteredShapefileGeoJson = { ...shapefileGeoJson, features: [...shapefileGeoJson.features] };

    if (selectedDepth) {
      console.log(`\n📏 Aplicando filtro de profundidade no CSV: ${selectedDepth}`);
      
      // Normalizar profundidade selecionada
      const normalizedDepth = selectedDepth.trim().replace(/\s*cm\s*/gi, '').toLowerCase();
      
      // Filtrar APENAS a planilha (coluna "Prof" ou similar)
      const depthColumn = Object.keys(spreadsheetData[0] || {}).find(col => 
        col.toLowerCase() === 'prof' || 
        col.toLowerCase() === 'profundidade' ||
        col.toLowerCase().includes('prof')
      );
      
      if (depthColumn) {
        filteredSpreadsheetData = spreadsheetData.filter(row => {
          const rowDepth = row[depthColumn];
          // Aceitar string ou número, mas ignorar null/undefined
          if (rowDepth !== null && rowDepth !== undefined && rowDepth !== 'NULL' && rowDepth !== '') {
            const rowDepthStr = String(rowDepth).trim();
            if (rowDepthStr) {
              const normalizedRowDepth = rowDepthStr.replace(/\s*cm\s*/gi, '').toLowerCase();
              return normalizedRowDepth === normalizedDepth;
            }
          }
          return false;
        });
        console.log(`   CSV filtrado por profundidade: ${filteredSpreadsheetData.length} registros (de ${spreadsheetData.length})`);
      } else {
        console.log(`   ⚠️ Coluna de profundidade não encontrada no CSV`);
      }
    }
    
    // Shapefile NÃO é filtrado por profundidade - mantém todos os features
    console.log(`   Shapefile: ${filteredShapefileGeoJson.features.length} features (sem filtro de profundidade)`);

    // Criar mapa dos dados da planilha filtrada
    const spreadsheetMap = new Map();
    filteredSpreadsheetData.forEach(row => {
      const key = String(row[spreadsheetColumn]).toLowerCase().trim();
      spreadsheetMap.set(key, row);
    });

    // Fazer merge com o GeoJSON filtrado
    const mergedFeatures = filteredShapefileGeoJson.features.map(feature => {
      const key = String(feature.properties[shapefileColumn] || '').toLowerCase().trim();
      const spreadsheetRow = spreadsheetMap.get(key);

      if (spreadsheetRow) {
        // Mesclar propriedades
        return {
          ...feature,
          properties: {
            ...feature.properties,
            ...spreadsheetRow
          }
        };
      }

      // Retornar feature mesmo sem match (manter todos os pontos)
      return feature;
    });

    const mergedGeoJson = {
      type: 'FeatureCollection',
      features: mergedFeatures
    };

    const matchedCount = mergedFeatures.filter(f => {
      const key = String(f.properties[shapefileColumn] || '').toLowerCase().trim();
      return spreadsheetMap.has(key);
    }).length;

    console.log(`\n📊 Estatísticas do Merge:`);
    console.log(`   Total de pontos no shapefile (após filtro): ${filteredShapefileGeoJson.features.length}`);
    console.log(`   Total de linhas na planilha (após filtro): ${filteredSpreadsheetData.length}`);
    console.log(`   Pontos com match (dados mesclados): ${matchedCount}`);
    console.log(`   Pontos sem match: ${mergedFeatures.length - matchedCount}`);
    console.log(`   Total de pontos no resultado: ${mergedFeatures.length}`);

    res.json({
      success: true,
      geojson: mergedGeoJson,
      matchedCount: matchedCount,
      totalCount: mergedFeatures.length,
      unmatchedCount: mergedFeatures.length - matchedCount
    });
  } catch (error) {
    console.error('Erro ao fazer merge:', error);
    res.status(500).json({ error: 'Erro ao fazer merge: ' + error.message });
  }
});

// Endpoint para interpolação
app.post('/api/interpolate', async (req, res) => {
  try {
    const { geoJson, parameters, method, resolution, searchRadius, propertyName } = req.body;
    
    // Salvar propertyName no req para uso posterior
    req.body.propertyName = propertyName || 'fazenda';

    if (!geoJson || !parameters || !method || !resolution || !searchRadius) {
      return res.status(400).json({ error: 'Dados incompletos para interpolação' });
    }

    if (!Array.isArray(parameters) || parameters.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um parâmetro para interpolar' });
    }

    console.log(`\n📊 Iniciando interpolação:`);
    console.log(`   Método: ${method}`);
    console.log(`   Parâmetros: ${parameters.join(', ')}`);
    console.log(`   Resolução: ${resolution}m`);
    console.log(`   Raio de busca: ${searchRadius}m`);
    console.log(`   Features: ${geoJson.features.length}`);

    // Criar arquivo temporário com os dados GeoJSON
    const tempFile = path.join(__dirname, 'uploads', 'temp_interpolation_data.geojson');
    fs.writeFileSync(tempFile, JSON.stringify(geoJson));

    // Criar diretório de saída
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const results = {
      success: true,
      method: method,
      bounds: null,
      tiffFiles: {},
      interpolations: {}
    };

    // Calcular bounds do GeoJSON
    if (geoJson.features.length > 0) {
      const coords = geoJson.features
        .filter(f => f.geometry && f.geometry.coordinates)
        .map(f => {
          const c = f.geometry.type === 'Point' 
            ? f.geometry.coordinates 
            : f.geometry.coordinates[0];
          return c;
        });
      
      if (coords.length > 0) {
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        results.bounds = [
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)]
        ];
      }
    }

    // Processar cada parâmetro sequencialmente
    let processedCount = 0;

    const processParameter = async (paramIndex) => {
      if (paramIndex >= parameters.length) {
        // Todos os parâmetros foram processados
        console.log('✅ Todas as interpolações concluídas');
        
        // Limpar arquivo temporário
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          console.warn('Aviso: não foi possível limpar arquivo temporário');
        }
        
        res.json(results);
        return;
      }

      const param = parameters[paramIndex];
      console.log(`\n📊 Processando parâmetro ${paramIndex + 1}/${parameters.length}: ${param}`);

      const args = [
        'soil_interpolation.py',
        '--input', tempFile,
        '--method', method,
        '--parameter', param,
        '--resolution', resolution.toString(),
        '--search-radius', searchRadius.toString(),
        '--output-dir', outputDir
      ];

      console.log(`🐍 Executando: python ${args.join(' ')}`);

      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const pythonProcess = spawn(pythonCmd, args, {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`Python stdout (${param}):`, data.toString().trim());
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`Python stderr (${param}):`, data.toString().trim());
      });

      pythonProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Interpolação concluída para ${param}`);

          // Verificar se o arquivo foi gerado
          const originalTiffFile = path.join(outputDir, `${param}_${method}_interpolation.tif`);
          
          if (fs.existsSync(originalTiffFile)) {
            // Criar nome descritivo: elemento_fazenda_metodo_data.tif
            // Usar nome da propriedade se disponível, senão usar 'fazenda'
            const propertyName = req.body?.propertyName || 'fazenda';
            const cleanPropertyName = propertyName.toLowerCase()
              .replace(/[^a-z0-9]/g, '_')
              .substring(0, 30); // Limitar tamanho
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const descriptiveName = `${param}_${cleanPropertyName}_${method}_${dateStr}.tif`;
            const descriptivePath = path.join(outputDir, descriptiveName);
            
            // Copiar arquivo com nome descritivo
            try {
              fs.copyFileSync(originalTiffFile, descriptivePath);
              console.log(`✅ TIFF salvo como: ${descriptiveName}`);
              results.tiffFiles[param] = `/output/${descriptiveName}`;
            } catch (copyError) {
              console.warn(`⚠️ Erro ao copiar TIFF, usando nome original: ${copyError.message}`);
              results.tiffFiles[param] = `/output/${param}_${method}_interpolation.tif`;
            }
            
            // Extrair estatísticas do output
            let min = 0, max = 1, mean = 0.5;
            const statsMatch = stdout.match(/STATS: min=([\d\.-]+), max=([\d\.-]+), mean=([\d\.-]+)/);
            if (statsMatch) {
              min = parseFloat(statsMatch[1]);
              max = parseFloat(statsMatch[2]);
              mean = parseFloat(statsMatch[3]);
            }

            // Calcular desvio padrão se possível
            let std = (max - min) / 4; // Estimativa padrão
            const stdMatch = stdout.match(/std[=:]?\s*([\d\.-]+)/i);
            if (stdMatch) {
              std = parseFloat(stdMatch[1]);
            }

            results.interpolations[param] = {
              success: true,
              tiffFile: results.tiffFiles[param],
              statistics: { 
                min, 
                max, 
                mean,
                std: std
              }
            };
          } else {
            results.interpolations[param] = {
              success: false,
              error: 'Arquivo TIFF não foi gerado'
            };
          }

          // Processar próximo parâmetro
          processParameter(paramIndex + 1);
        } else {
          console.error(`❌ Erro na interpolação para ${param}. Código: ${code}`);
          results.interpolations[param] = {
            success: false,
            error: stderr || 'Erro desconhecido'
          };
          
          // Continuar com próximo parâmetro mesmo em caso de erro
          processParameter(paramIndex + 1);
        }
      });

      pythonProcess.on('error', (err) => {
        console.error(`❌ Erro ao executar Python para ${param}:`, err);
        results.interpolations[param] = {
          success: false,
          error: `Erro ao executar Python: ${err.message}`
        };
        processParameter(paramIndex + 1);
      });
    };

    // Iniciar processamento
    processParameter(0);

  } catch (error) {
    console.error('❌ Erro na rota de interpolação:', error);
    res.status(500).json({ error: 'Erro interno do servidor: ' + error.message });
  }
});

// Servir arquivos de output
app.use('/output', express.static(path.join(__dirname, 'output')));

// Endpoint para upload de shapefile de limites
const boundaryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = path.join(__dirname, 'uploads', 'boundaries');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `boundary_${Date.now()}_${file.originalname}`);
  }
});

const boundaryUpload = multer({ storage: boundaryStorage });

app.post('/api/upload-boundary-shapefile', boundaryUpload.single('shapefile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const filePath = req.file.path;
    const zipPath = filePath;

    // Extrair ZIP
    const extractDir = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Usar JSZip para extrair
    const JSZip = require('jszip');
    const zipBuffer = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);

    let shpPath = null;
    let prjPath = null;

    for (const [filename, file] of Object.entries(zip.files)) {
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.shp') {
        shpPath = path.join(extractDir, filename);
        const buffer = await file.async('nodebuffer');
        fs.writeFileSync(shpPath, buffer);
      } else if (ext === '.prj') {
        prjPath = path.join(extractDir, filename);
        const buffer = await file.async('nodebuffer');
        fs.writeFileSync(prjPath, buffer);
      } else if (['.dbf', '.shx', '.cpg'].includes(ext)) {
        const fullPath = path.join(extractDir, filename);
        const buffer = await file.async('nodebuffer');
        fs.writeFileSync(fullPath, buffer);
      }
    }

    if (!shpPath || !fs.existsSync(shpPath)) {
      return res.status(400).json({ error: 'Arquivo .shp não encontrado no ZIP' });
    }

    res.json({
      success: true,
      shapefilePath: shpPath,
      message: 'Shapefile de limites carregado com sucesso'
    });
  } catch (error) {
    console.error('Erro ao processar shapefile de limites:', error);
    res.status(500).json({ error: 'Erro ao processar shapefile: ' + error.message });
  }
});

// Endpoint para gerar relatório PDF
app.post('/api/generate-report', async (req, res) => {
  console.log('\n📄 === INÍCIO GERAÇÃO DE RELATÓRIO ===');
  console.log('Body recebido:', JSON.stringify(req.body, null, 2).substring(0, 500));
  
  try {
    const { propertyName, ownerName, plotName, cropSeason, depth, area, interpolations, tiffFiles, boundaryShapefile } = req.body;

    if (!propertyName || !plotName || !interpolations || !tiffFiles) {
      return res.status(400).json({ success: false, error: 'Dados incompletos para gerar relatório' });
    }

    console.log(`\n📄 Gerando relatório PDF:`);
    console.log(`   Propriedade: ${propertyName}`);
    console.log(`   Proprietário: ${ownerName || propertyName}`);
    console.log(`   Talhão: ${plotName}`);
    console.log(`   Safra: ${cropSeason || '24/25'}`);
    console.log(`   Profundidade: ${depth || '0-20 cm'}`);

    // Criar diretório de relatórios
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Nome do arquivo PDF com timestamp único para evitar conflitos
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '').substring(0, 6); // HHMMSS
    let pdfFilename = `relatorio_fertilidade_${dateStr}_${timeStr}.pdf`;
    let pdfPath = path.join(reportsDir, pdfFilename);
    
    // Verificar se o arquivo já existe e tentar remover (caso esteja bloqueado)
    if (fs.existsSync(pdfPath)) {
      try {
        // Tentar remover arquivo antigo se existir
        fs.unlinkSync(pdfPath);
        console.log(`📄 Arquivo antigo removido: ${pdfFilename}`);
      } catch (err) {
        // Se não conseguir remover, gerar nome único com timestamp em milissegundos
        const uniqueId = Date.now();
        pdfFilename = `relatorio_fertilidade_${dateStr}_${uniqueId}.pdf`;
        pdfPath = path.join(reportsDir, pdfFilename);
        console.warn(`⚠️ Arquivo bloqueado, usando nome alternativo: ${pdfFilename}`);
      }
    }

    // Converter caminhos relativos dos TIFFs para caminhos absolutos
    const tiffFilesAbsolute = {};
    for (const [param, tiffPath] of Object.entries(tiffFiles)) {
      if (tiffPath) {
        // Se for caminho relativo, converter para absoluto
        if (tiffPath.startsWith('/output/')) {
          const tiffName = tiffPath.replace('/output/', '');
          const tiffFullPath = path.join(__dirname, 'output', tiffName);
          tiffFilesAbsolute[param] = tiffFullPath;
          console.log(`📁 TIFF ${param}: ${tiffFullPath} (existe: ${fs.existsSync(tiffFullPath)})`);
        } else {
          tiffFilesAbsolute[param] = tiffPath;
          console.log(`📁 TIFF ${param}: ${tiffPath} (existe: ${fs.existsSync(tiffPath)})`);
        }
      } else {
        console.warn(`⚠️ TIFF ${param}: caminho vazio`);
      }
    }
    
    // Verificar se há TIFFs válidos
    const validTiffs = Object.values(tiffFilesAbsolute).filter(p => p && fs.existsSync(p));
    if (validTiffs.length === 0) {
      console.error('❌ Nenhum arquivo TIFF válido encontrado!');
      return res.status(400).json({
        success: false,
        error: 'Nenhum arquivo TIFF válido encontrado. Faça a interpolação primeiro.'
      });
    }
    
    console.log(`✅ ${validTiffs.length} arquivo(s) TIFF válido(s) encontrado(s)`);

    // Garantir que o diretório existe e tem permissões
    try {
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      // Testar escrita no diretório
      const testFile = path.join(reportsDir, '.test_write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log(`✅ Diretório de relatórios verificado: ${reportsDir}`);
    } catch (err) {
      console.error(`❌ Erro ao verificar diretório de relatórios: ${err.message}`);
      return res.status(500).json({
        success: false,
        error: `Erro de permissão no diretório de relatórios: ${err.message}`
      });
    }
    
    // Preparar argumentos para o script Python
    const args = [
      'generate_fertility_report.py',
      '--output', pdfPath,
      '--property-name', propertyName,
      '--owner-name', req.body.ownerName || propertyName,
      '--plot-name', plotName,
      '--crop-season', req.body.cropSeason || '24/25',
      '--depth', req.body.depth || '0-20 cm',
      '--area', (area || 0).toString(),
      '--interpolations', JSON.stringify(interpolations),
      '--tiff-files', JSON.stringify(tiffFilesAbsolute)
    ];

    // Adicionar logo se existir
    const logoPath = path.join(__dirname, '..', 'asset', 'Logos-04.png');
    if (fs.existsSync(logoPath)) {
      args.push('--logo', logoPath);
    }
    
    // Adicionar shapefile de limites se fornecido
    if (boundaryShapefile) {
      // Converter para caminho absoluto se necessário
      const boundaryPath = path.isAbsolute(boundaryShapefile) 
        ? boundaryShapefile 
        : path.join(__dirname, boundaryShapefile);
      
      if (fs.existsSync(boundaryPath)) {
        args.push('--boundary-shapefile', boundaryPath);
        console.log(`📁 Usando shapefile de limites: ${boundaryPath}`);
        console.log(`   Arquivo existe: ${fs.existsSync(boundaryPath)}`);
        console.log(`   Tamanho: ${fs.statSync(boundaryPath).size} bytes`);
      } else {
        console.warn(`⚠️ Shapefile de limites não encontrado: ${boundaryPath}`);
        console.warn(`   Caminho original: ${boundaryShapefile}`);
        console.warn(`   Caminho absoluto: ${boundaryPath}`);
      }
    } else {
      console.log(`ℹ️ Nenhum shapefile de limites fornecido`);
    }

    console.log(`🐍 Executando: python ${args.join(' ')}`);

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonProcess = spawn(pythonCmd, args, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Tentar parsear JSON se for uma linha JSON
      try {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
            const jsonData = JSON.parse(line.trim());
            if (jsonData.error) {
              console.error(`❌ Python error:`, jsonData.error);
            } else if (jsonData.info) {
              console.log(`ℹ️ Python info:`, jsonData.info);
            } else if (jsonData.warning) {
              console.warn(`⚠️ Python warning:`, jsonData.warning);
            }
          }
        }
      } catch (e) {
        // Não é JSON, apenas log normal
        console.log(`Python stdout:`, text.trim());
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.log(`Python stderr:`, text.trim());
    });

    pythonProcess.on('close', (code) => {
      console.log(`\n📄 Processo Python finalizado. Código: ${code}`);
      console.log(`stdout: ${stdout.substring(0, 500)}`);
      console.log(`stderr: ${stderr.substring(0, 500)}`);
      
      if (code === 0) {
        console.log(`✅ Relatório PDF gerado: ${pdfPath}`);
        
        if (fs.existsSync(pdfPath)) {
          console.log(`✅ PDF existe, enviando como download`);
          
          // Ler o arquivo PDF
          const pdfBuffer = fs.readFileSync(pdfPath);
          const pdfStats = fs.statSync(pdfPath);
          
          // Configurar headers para download
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename}"`);
          res.setHeader('Content-Length', pdfStats.size);
          
          // Enviar o PDF
          return res.send(pdfBuffer);
        } else {
          console.error(`❌ PDF não existe em: ${pdfPath}`);
          return res.status(500).json({
            success: false,
            error: 'PDF não foi gerado. Verifique os logs do Python.'
          });
        }
      } else {
        console.error(`❌ Erro ao gerar PDF. Código: ${code}`);
        console.error(`stderr completo: ${stderr}`);
        
        // Verificar se é erro de permissão
        const errorText = (stderr + stdout).toLowerCase();
        if (errorText.includes('permission denied') || errorText.includes('errno 13') || errorText.includes('permissionerror')) {
          console.error(`❌ Erro de permissão detectado!`);
          console.error(`   Caminho: ${pdfPath}`);
          console.error(`   Possível causa: Arquivo PDF está aberto em outro programa`);
          
          return res.status(500).json({
            success: false,
            error: `Erro de permissão ao salvar PDF. O arquivo pode estar aberto em outro programa.`,
            suggestion: 'Feche o PDF anterior se estiver aberto e tente gerar novamente.',
            details: `Caminho: ${pdfPath}`
          });
        }
        
        // Extrair mensagem de erro mais clara
        let errorMsg = 'Erro desconhecido ao gerar PDF';
        if (stderr) {
          const lines = stderr.split('\n');
          const errorLines = lines.filter(l => 
            l.includes('Error') || 
            l.includes('error') || 
            l.includes('Exception') ||
            l.includes('Traceback')
          );
          if (errorLines.length > 0) {
            errorMsg = errorLines.slice(0, 3).join(' | ');
          } else {
            errorMsg = stderr.substring(0, 200);
          }
        }
        
        return res.status(500).json({
          success: false,
          error: errorMsg,
          code: code,
          details: stderr.substring(0, 500)
        });
      }
    });

    pythonProcess.on('error', (err) => {
      console.error(`❌ Erro ao executar Python:`, err);
      console.error(`Erro completo:`, JSON.stringify(err, null, 2));
      return res.status(500).json({
        success: false,
        error: `Erro ao executar Python: ${err.message}`,
        details: err.toString()
      });
    });
    
    // Timeout de segurança (5 minutos)
    setTimeout(() => {
      if (!pythonProcess.killed) {
        console.error(`⏱️ Timeout ao gerar PDF`);
        pythonProcess.kill();
        return res.status(500).json({
          success: false,
          error: 'Timeout ao gerar PDF (mais de 5 minutos)'
        });
      }
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('❌ Erro na rota de geração de relatório:', error);
    console.error('Stack trace:', error.stack);
    return res.status(500).json({ 
      success: false,
      error: 'Erro interno do servidor: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Servir arquivos de relatórios
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// Servir arquivos estáticos (deve vir por último para não interceptar rotas de API)
app.use(express.static('public'));

// Middleware de tratamento de erros - garantir que sempre retorne JSON
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Erro interno do servidor',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Rota 404 para APIs - retornar JSON
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Rota de API não encontrada: ' + req.path
  });
});

// Limpar arquivos temporários
app.post('/api/cleanup', (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, 'uploads');
    const outputDir = path.join(__dirname, 'output');
    
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    res.json({ success: true, message: 'Arquivos temporários limpos' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao limpar arquivos: ' + error.message });
  }
});

// Health check endpoint para Render
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
