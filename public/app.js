// Variáveis globais
let map;
let spreadsheetData = null;
let shapefileGeoJson = null;
let mergedGeoJson = null;
let currentLayer = null;
let baseLayers = {};
let overlayLayers = {};
let layerControl = null;
let interpolationResults = null; // Armazenar resultados da interpolação
let boundaryShapefilePath = null; // Caminho do shapefile de limites
let availableDepths = []; // Profundidades disponíveis nos dados
let selectedDepth = null; // Profundidade selecionada para filtro

// Modal de Disclaimer
function initDisclaimerModal() {
    // Verificar se o usuário já optou por não mostrar novamente
    const dontShowAgain = localStorage.getItem('dontShowDisclaimer');
    if (dontShowAgain === 'true') {
        return; // Não mostrar o modal
    }

    // Mostrar modal
    const modal = document.getElementById('disclaimer-modal');
    modal.classList.add('active');

    // Fechar modal
    document.getElementById('close-disclaimer').addEventListener('click', () => {
        const checkbox = document.getElementById('dont-show-again');
        if (checkbox.checked) {
            localStorage.setItem('dontShowDisclaimer', 'true');
        }
        modal.classList.remove('active');
    });

    // Fechar ao clicar fora do modal
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            const checkbox = document.getElementById('dont-show-again');
            if (checkbox.checked) {
                localStorage.setItem('dontShowDisclaimer', 'true');
            }
            modal.classList.remove('active');
        }
    });
}

// Inicializar modal quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    initDisclaimerModal();
});

// Parâmetros disponíveis (baseado na imagem)
const availableParameters = [
    'pH_CaCl2', 'P', 'K', 'Ca', 'Mg', 'Al', 'MO', 'Argila', 
    'Sb', 'CTC', 'V%', 'Zn', 'Cu', 'Fe', 'Mn', 'S', 'B'
];

// Parâmetros pré-selecionados (destacados em amarelo na imagem)
const defaultSelectedParameters = ['Zn', 'Cu', 'Fe', 'Mn'];

// Inicializar mapa
function initMap() {
    // Criar mapa centrado no Brasil
    map = L.map('map', {
        center: [-15.7975, -47.8919],
        zoom: 4
    });

    // Criar camadas base
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxZoom: 19
    });

    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    });

    const labelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri',
        maxZoom: 19,
        opacity: 0.7
    });

    // Adicionar camadas base ao objeto
    baseLayers = {
        'Satélite': satelliteLayer,
        'OpenStreetMap': osmLayer
    };

    // Adicionar camada padrão
    satelliteLayer.addTo(map);
    labelsLayer.addTo(map);

    // Criar controle de camadas
    layerControl = L.control.layers(baseLayers, overlayLayers, {
        collapsed: true,
        position: 'topright'
    }).addTo(map);
}

// Função para mostrar status
function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.classList.remove('hidden');
}

// Função para ocultar status
function hideStatus() {
    document.getElementById('status').classList.add('hidden');
}

// Upload de planilha
document.getElementById('spreadsheet-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showStatus('Carregando planilha...', 'info');

    try {
        const response = await fetch('/api/upload-spreadsheet', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            spreadsheetData = result.data;
            
            // Mostrar informações do arquivo
            const infoDiv = document.getElementById('spreadsheet-info');
            infoDiv.textContent = `✓ ${result.filename} - ${result.data.length} linhas`;
            infoDiv.classList.remove('hidden');

            // Preencher dropdown de colunas
            const columnSelect = document.getElementById('spreadsheet-column');
            columnSelect.innerHTML = '<option value="">Selecione uma coluna</option>';
            result.columns.forEach(col => {
                const option = document.createElement('option');
                option.value = col;
                option.textContent = col;
                columnSelect.appendChild(option);
            });

            document.getElementById('spreadsheet-column-group').classList.remove('hidden');
            
            // Detectar profundidades na planilha
            detectDepthsFromSpreadsheet(result.data, result.columns);
            
            showStatus(`Planilha carregada: ${result.data.length} registros`, 'success');
            checkMergeButton();
        } else {
            showStatus('Erro: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Erro ao carregar planilha: ' + error.message, 'error');
    }
});

// Upload de shapefile
document.getElementById('shapefile-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showStatus('Extraindo e carregando shapefile...', 'info');

    try {
        const response = await fetch('/api/upload-shapefile', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            shapefileGeoJson = result.geojson;
            
            // Mostrar informações do arquivo
            const infoDiv = document.getElementById('shapefile-info');
            infoDiv.textContent = `✓ ${result.filename} - ${result.geojson.features.length} features`;
            infoDiv.classList.remove('hidden');

            // Preencher dropdown de colunas
            const columnSelect = document.getElementById('shapefile-column');
            columnSelect.innerHTML = '<option value="">Selecione uma coluna</option>';
            result.columns.forEach(col => {
                const option = document.createElement('option');
                option.value = col;
                option.textContent = col;
                columnSelect.appendChild(option);
            });

            document.getElementById('shapefile-column-group').classList.remove('hidden');
            
            // Carregar shapefile diretamente no mapa
            loadShapefileToMap(result.geojson, 'Shapefile Original');
            
            showStatus(`Shapefile carregado: ${result.geojson.features.length} features`, 'success');
            checkMergeButton();
        } else {
            showStatus('Erro: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Erro ao carregar shapefile: ' + error.message, 'error');
    }
});

// Função para carregar dados merged no mapa
function loadMergedDataToMap(geojson, layerName) {
    // Remover layer anterior se existir
    if (overlayLayers[layerName]) {
        map.removeLayer(overlayLayers[layerName]);
        delete overlayLayers[layerName];
    }

    // Criar novo layer
    const mergedLayer = L.geoJSON(geojson, {
        style: function(feature) {
            return {
                color: '#667eea',
                weight: 2,
                opacity: 0.8,
                fillColor: '#667eea',
                fillOpacity: 0.3
            };
        },
        pointToLayer: function(feature, latlng) {
            // Renderizar pontos como círculos ao invés de marcadores
            return L.circleMarker(latlng, {
                radius: 5,
                fillColor: '#667eea',
                color: '#667eea',
                weight: 2,
                opacity: 0.8,
                fillOpacity: 0.6
            });
        },
        onEachFeature: function(feature, layer) {
            // Criar popup com todas as propriedades
            let popupContent = '<div style="max-width: 300px;"><strong>Propriedades:</strong><br>';
            for (const [key, value] of Object.entries(feature.properties)) {
                popupContent += `<strong>${key}:</strong> ${value}<br>`;
            }
            popupContent += '</div>';
            layer.bindPopup(popupContent);
        }
    });

    // Adicionar ao mapa e ao controle de camadas
    mergedLayer.addTo(map);
    overlayLayers[layerName] = mergedLayer;
    
    // Atualizar controle de camadas
    if (layerControl) {
        layerControl.remove();
    }
    layerControl = L.control.layers(baseLayers, overlayLayers, {
        collapsed: true,
        position: 'topright'
    }).addTo(map);

    // Ajustar zoom para mostrar todos os features
    map.fitBounds(mergedLayer.getBounds(), { padding: [50, 50] });
    
    currentLayer = mergedLayer;
}

// Função para carregar shapefile no mapa
function loadShapefileToMap(geojson, layerName) {
    // Remover layer anterior do shapefile se existir
    if (overlayLayers['Shapefile Original']) {
        map.removeLayer(overlayLayers['Shapefile Original']);
        delete overlayLayers['Shapefile Original'];
    }

    // Criar novo layer
    const shapefileLayer = L.geoJSON(geojson, {
        style: function(feature) {
            return {
                color: '#ff6b6b',
                weight: 2,
                opacity: 0.8,
                fillColor: '#ff6b6b',
                fillOpacity: 0.2
            };
        },
        pointToLayer: function(feature, latlng) {
            // Renderizar pontos como círculos ao invés de marcadores
            return L.circleMarker(latlng, {
                radius: 5,
                fillColor: '#ff6b6b',
                color: '#ff6b6b',
                weight: 2,
                opacity: 0.8,
                fillOpacity: 0.6
            });
        },
        onEachFeature: function(feature, layer) {
            // Criar popup com todas as propriedades
            let popupContent = '<div style="max-width: 300px;"><strong>Propriedades:</strong><br>';
            for (const [key, value] of Object.entries(feature.properties)) {
                popupContent += `<strong>${key}:</strong> ${value}<br>`;
            }
            popupContent += '</div>';
            layer.bindPopup(popupContent);
        }
    });

    // Adicionar ao mapa e ao controle de camadas
    shapefileLayer.addTo(map);
    overlayLayers[layerName] = shapefileLayer;
    
    // Atualizar controle de camadas
    if (layerControl) {
        layerControl.remove();
    }
    layerControl = L.control.layers(baseLayers, overlayLayers, {
        collapsed: true,
        position: 'topright'
    }).addTo(map);

    // Ajustar zoom para mostrar todos os features
    map.fitBounds(shapefileLayer.getBounds(), { padding: [50, 50] });
}

// Função para detectar profundidades na planilha
function detectDepthsFromSpreadsheet(data, columns) {
    const depthColumn = columns.find(col => 
        col.toLowerCase() === 'prof' || 
        col.toLowerCase() === 'profundidade' ||
        col.toLowerCase().includes('prof')
    );
    
    if (!depthColumn || !data || data.length === 0) {
        return;
    }
    
    const depths = new Set();
    data.forEach(row => {
        const depth = row[depthColumn];
        if (depth !== null && depth !== undefined) {
            // Aceitar string ou número
            const depthStr = String(depth).trim();
            if (depthStr) {
                // Normalizar formato (ex: "0-20", "0-20 cm", "20-40")
                const normalized = depthStr.replace(/\s*cm\s*/gi, '').toLowerCase();
                if (normalized) {
                    depths.add(normalized);
                }
            }
        }
    });
    
    updateDepthSelector(Array.from(depths).sort());
}

// Função removida - profundidade agora é detectada apenas no CSV/XLSX

// Função para atualizar o seletor de profundidade
function updateDepthSelector(depths) {
    if (depths.length === 0) {
        return;
    }
    
    // Combinar com profundidades já existentes
    depths.forEach(d => availableDepths.push(d));
    availableDepths = [...new Set(availableDepths)].sort();
    
    const depthSelect = document.getElementById('depth-select');
    const depthSection = document.getElementById('depth-filter-section');
    
    if (availableDepths.length > 0) {
        depthSection.classList.remove('hidden');
        depthSelect.innerHTML = '<option value="">Selecione uma profundidade</option>';
        availableDepths.forEach(depth => {
            const option = document.createElement('option');
            option.value = depth;
            option.textContent = depth;
            depthSelect.appendChild(option);
        });
    }
}

// Event listener para seleção de profundidade
document.getElementById('depth-select').addEventListener('change', (e) => {
    selectedDepth = e.target.value;
    const infoDiv = document.getElementById('selected-depth-info');
    if (selectedDepth) {
        infoDiv.textContent = `✓ Profundidade selecionada: ${selectedDepth}`;
        infoDiv.style.borderLeftColor = 'var(--success-color)';
    } else {
        infoDiv.textContent = 'Nenhuma profundidade selecionada';
        infoDiv.style.borderLeftColor = 'var(--border-color)';
    }
});

// Verificar se pode fazer merge
function checkMergeButton() {
    const spreadsheetColumn = document.getElementById('spreadsheet-column').value;
    const shapefileColumn = document.getElementById('shapefile-column').value;
    const mergeBtn = document.getElementById('merge-btn');

    if (spreadsheetData && shapefileGeoJson && spreadsheetColumn && shapefileColumn) {
        mergeBtn.disabled = false;
    } else {
        mergeBtn.disabled = true;
    }
}

// Event listeners para dropdowns
document.getElementById('spreadsheet-column').addEventListener('change', checkMergeButton);
document.getElementById('shapefile-column').addEventListener('change', checkMergeButton);

// Fazer merge
document.getElementById('merge-btn').addEventListener('click', async () => {
    const spreadsheetColumn = document.getElementById('spreadsheet-column').value;
    const shapefileColumn = document.getElementById('shapefile-column').value;

    if (!spreadsheetData || !shapefileGeoJson || !spreadsheetColumn || !shapefileColumn) {
        showStatus('Por favor, selecione as colunas para merge', 'error');
        return;
    }

    showStatus('Fazendo merge dos dados...', 'info');
    document.getElementById('merge-btn').disabled = true;

    try {
        const response = await fetch('/api/merge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                spreadsheetData: spreadsheetData,
                shapefileGeoJson: shapefileGeoJson,
                spreadsheetColumn: spreadsheetColumn,
                shapefileColumn: shapefileColumn,
                selectedDepth: selectedDepth // Enviar profundidade selecionada
            })
        });

        const result = await response.json();

        if (result.success) {
            // Remover layer anterior do merge se existir
            if (overlayLayers['Dados Merged']) {
                map.removeLayer(overlayLayers['Dados Merged']);
                delete overlayLayers['Dados Merged'];
            }

            // Salvar dados merged
            mergedGeoJson = result.geojson;

            // Carregar dados merged no mapa
            loadMergedDataToMap(result.geojson, 'Dados Merged');

            // Mostrar seção de interpolação e preencher parâmetros
            showInterpolationSection();

            showStatus(
                `Merge concluído! ${result.matchedCount} de ${result.totalCount} features correspondidos`,
                'success'
            );
        } else {
            showStatus('Erro: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Erro ao fazer merge: ' + error.message, 'error');
    } finally {
        document.getElementById('merge-btn').disabled = false;
    }
});

// Limpar dados
document.getElementById('cleanup-btn').addEventListener('click', async () => {
    if (confirm('Tem certeza que deseja limpar todos os dados?')) {
        try {
            const response = await fetch('/api/cleanup', {
                method: 'POST'
            });

            const result = await response.json();

            if (result.success) {
                // Limpar variáveis
                spreadsheetData = null;
                shapefileGeoJson = null;

                // Limpar UI
                document.getElementById('spreadsheet-file').value = '';
                document.getElementById('shapefile-file').value = '';
                document.getElementById('spreadsheet-info').classList.add('hidden');
                document.getElementById('shapefile-info').classList.add('hidden');
                document.getElementById('spreadsheet-column-group').classList.add('hidden');
                document.getElementById('shapefile-column-group').classList.add('hidden');
                document.getElementById('spreadsheet-column').innerHTML = '<option value="">Selecione uma coluna</option>';
                document.getElementById('shapefile-column').innerHTML = '<option value="">Selecione uma coluna</option>';

                // Remover todas as camadas overlay do mapa
                Object.keys(overlayLayers).forEach(key => {
                    map.removeLayer(overlayLayers[key]);
                });
                overlayLayers = {};
                
                // Atualizar controle de camadas
                if (layerControl) {
                    layerControl.remove();
                }
                layerControl = L.control.layers(baseLayers, overlayLayers, {
                    collapsed: true,
                    position: 'topright'
                }).addTo(map);
                
                currentLayer = null;

                // Resetar profundidades
                availableDepths = [];
                selectedDepth = null;
                document.getElementById('depth-select').innerHTML = '<option value="">Selecione uma profundidade</option>';
                document.getElementById('depth-filter-section').classList.add('hidden');
                document.getElementById('selected-depth-info').textContent = 'Nenhuma profundidade selecionada';

                checkMergeButton();
                showStatus('Dados limpos com sucesso', 'success');
            }
        } catch (error) {
            showStatus('Erro ao limpar dados: ' + error.message, 'error');
        }
    }
});

// Função para mostrar seção de interpolação e preencher parâmetros
function showInterpolationSection() {
    const section = document.getElementById('interpolation-section');
    section.classList.remove('hidden');

    // Preencher checklist de parâmetros
    const checklist = document.getElementById('parameters-checklist');
    checklist.innerHTML = '';

    // Obter colunas disponíveis dos dados merged
    let availableCols = [];
    if (mergedGeoJson && mergedGeoJson.features.length > 0) {
        availableCols = Object.keys(mergedGeoJson.features[0].properties || {});
    }

    // Filtrar apenas parâmetros que existem nos dados
    const existingParams = availableParameters.filter(param => 
        availableCols.some(col => col.toLowerCase() === param.toLowerCase())
    );

    // Se não encontrar os parâmetros exatos, usar todas as colunas numéricas
    const paramsToShow = existingParams.length > 0 ? existingParams : availableCols;

    paramsToShow.forEach(param => {
        const isDefault = defaultSelectedParameters.includes(param);
        const checkbox = document.createElement('div');
        checkbox.className = 'parameter-item' + (isDefault ? ' selected' : '');
        checkbox.innerHTML = `
            <label>
                <input type="checkbox" value="${param}" ${isDefault ? 'checked' : ''}>
                <span>${param}</span>
            </label>
        `;
        
        // Adicionar listener para atualizar classe quando checkbox mudar
        const input = checkbox.querySelector('input');
        input.addEventListener('change', () => {
            if (input.checked) {
                checkbox.classList.add('selected');
            } else {
                checkbox.classList.remove('selected');
            }
        });
        
        checklist.appendChild(checkbox);
    });

    // Habilitar botão de interpolação
    document.getElementById('interpolate-btn').disabled = false;
}

// Função para obter parâmetros selecionados
function getSelectedParameters() {
    const checkboxes = document.querySelectorAll('#parameters-checklist input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

// Event listener para botão de interpolação
document.getElementById('interpolate-btn').addEventListener('click', async () => {
    if (!mergedGeoJson) {
        showStatus('Faça o merge primeiro!', 'error');
        return;
    }

    const selectedParams = getSelectedParameters();
    if (selectedParams.length === 0) {
        showStatus('Selecione pelo menos um parâmetro para interpolar', 'error');
        return;
    }

    const method = document.getElementById('interpolation-method').value;
    const resolution = parseFloat(document.getElementById('resolution').value);
    const searchRadius = parseFloat(document.getElementById('search-radius').value);

    const statusDiv = document.getElementById('interpolation-status');
    statusDiv.textContent = `Gerando interpolação para ${selectedParams.length} parâmetro(s)...`;
    statusDiv.className = 'status info';
    statusDiv.classList.remove('hidden');

    document.getElementById('interpolate-btn').disabled = true;

    try {
        const response = await fetch('/api/interpolate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                geoJson: mergedGeoJson,
                parameters: selectedParams,
                method: method,
                resolution: resolution,
                searchRadius: searchRadius,
                propertyName: 'fazenda' // Será atualizado quando o usuário gerar o relatório
            })
        });

        const result = await response.json();

        if (result.success) {
            statusDiv.textContent = `Interpolação concluída! ${selectedParams.length} parâmetro(s) processado(s)`;
            statusDiv.className = 'status success';
            
            // Carregar resultados no mapa se houver TIFFs
            if (result.tiffFiles && Object.keys(result.tiffFiles).length > 0) {
                await loadInterpolationResults(result.tiffFiles, result.bounds, result.interpolations);
            }
        } else {
            statusDiv.textContent = 'Erro: ' + result.error;
            statusDiv.className = 'status error';
        }
    } catch (error) {
        statusDiv.textContent = 'Erro ao gerar interpolação: ' + error.message;
        statusDiv.className = 'status error';
    } finally {
        document.getElementById('interpolate-btn').disabled = false;
    }
});

// Função para carregar resultados de interpolação no mapa
async function loadInterpolationResults(tiffFiles, bounds, interpolations) {
    console.log('📊 Carregando resultados de interpolação:', tiffFiles);
    
    // Salvar resultados globalmente
    interpolationResults = {
        tiffFiles: tiffFiles,
        bounds: bounds,
        interpolations: interpolations
    };
    
    // Mostrar seção de resultados
    const resultsSection = document.getElementById('results-section');
    resultsSection.classList.remove('hidden');
    
    // Gerar cards de estatísticas
    generateStatisticsCards(interpolations);
    
    // Carregar cada TIFF no mapa
    for (const [param, tiffUrl] of Object.entries(tiffFiles)) {
        if (tiffUrl) {
            const stats = interpolations[param]?.statistics || {};
            await addTiffLayer(tiffUrl, param, stats.min, stats.max);
        }
    }
}

// Função para gerar cards de estatísticas
function generateStatisticsCards(interpolations) {
    // Container no sidebar (versão compacta)
    const sidebarContainer = document.getElementById('statistics-cards');
    sidebarContainer.innerHTML = '';
    
    // Container abaixo do mapa (versão expandida)
    const resultsContainer = document.getElementById('results-container');
    const resultsGrid = document.getElementById('results-grid');
    resultsGrid.innerHTML = '';
    
    // Mostrar container de resultados
    resultsContainer.classList.remove('hidden');
    
    for (const [param, data] of Object.entries(interpolations)) {
        if (data.success && data.statistics) {
            const stats = data.statistics;
            
            // Card compacto no sidebar
            const sidebarCard = document.createElement('div');
            sidebarCard.className = 'stat-card';
            sidebarCard.style.marginBottom = '0.75rem';
            sidebarCard.innerHTML = `
                <div style="font-weight: 600; color: var(--primary-color); margin-bottom: 0.5rem; font-size: 0.95rem;">${param}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">
                    Min: ${stats.min.toFixed(2)} | Max: ${stats.max.toFixed(2)} | Média: ${stats.mean.toFixed(2)}
                </div>
            `;
            sidebarContainer.appendChild(sidebarCard);
            
            // Card expandido abaixo do mapa
            const expandedCard = document.createElement('div');
            expandedCard.className = 'stat-card';
            expandedCard.innerHTML = `
                <div class="stat-card-header">
                    <h3 class="stat-card-title">${param}</h3>
                    <div class="stat-card-icon">📊</div>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Mínimo:</span>
                    <span class="stat-value">${stats.min.toFixed(2)}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Máximo:</span>
                    <span class="stat-value">${stats.max.toFixed(2)}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Média:</span>
                    <span class="stat-value">${stats.mean.toFixed(2)}</span>
                </div>
                ${stats.std ? `
                <div class="stat-row">
                    <span class="stat-label">Desvio Padrão:</span>
                    <span class="stat-value">${stats.std.toFixed(2)}</span>
                </div>
                ` : ''}
            `;
            resultsGrid.appendChild(expandedCard);
        }
    }
}

// Função para adicionar camada TIFF no mapa (baseada no ConnecFarm)
async function addTiffLayer(tiffUrl, layerName, minHint = null, maxHint = null) {
    try {
        console.log(`🚀 Carregando TIFF: ${tiffUrl}`);
        
        // Verificar se as bibliotecas estão disponíveis
        if (typeof parseGeoraster === 'undefined') {
            throw new Error('parseGeoraster não está disponível');
        }
        
        if (typeof GeoRasterLayer === 'undefined') {
            throw new Error('GeoRasterLayer não está disponível');
        }
        
        // Carregar o TIFF
        const response = await fetch(tiffUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const georaster = await parseGeoraster(arrayBuffer);
        
        if (!georaster || !georaster.pixelWidth) {
            throw new Error('Georaster inválido ou sem dados');
        }
        
        // Obter valores min/max
        let min, max;
        if (minHint !== null && maxHint !== null) {
            min = minHint;
            max = maxHint;
        } else {
            const mins = georaster.mins || [georaster.min ?? 0];
            const maxs = georaster.maxs || [georaster.max ?? 1];
            min = mins[0];
            max = maxs[0];
            
            // Calcular dos dados se necessário
            if (min === max || (min === 0 && max === 1)) {
                const values = georaster.values[0];
                if (values && values.length > 0) {
                    const validValues = values.filter(v => 
                        v !== null && !isNaN(v) && v !== georaster.noDataValue
                    );
                    if (validValues.length > 0) {
                        min = Math.min(...validValues);
                        max = Math.max(...validValues);
                    }
                }
            }
        }
        
        console.log(`📊 Estatísticas TIFF ${layerName}: min=${min}, max=${max}`);
        
        // Função de cores (RdYlGn - Red→Yellow→Green)
        const pixelValuesToColorFn = (values) => {
            const v = values[0];
            if (v == null || Number.isNaN(v) || v === georaster.noDataValue) return null;
            
            const range = Math.max(max - min, 0.001);
            const t = Math.max(0, Math.min(1, (v - min) / range));
            
            // RdYlGn color ramp
            if (t < 0.5) {
                // Red to Yellow
                const r = 1.0;
                const g = t * 2;
                const b = 0;
                return `rgba(${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(b * 255)}, 0.7)`;
            } else {
                // Yellow to Green
                const r = 1.0 - (t - 0.5) * 2;
                const g = 1.0;
                const b = 0;
                return `rgba(${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(b * 255)}, 0.7)`;
            }
        };
        
        // Criar GeoRasterLayer
        const tiffLayer = new GeoRasterLayer({
            georaster: georaster,
            opacity: 0.7,
            pixelValuesToColorFn: pixelValuesToColorFn,
            resolution: 128,
            debugLevel: -1
        });
        
        // Anexar informações ao layer
        tiffLayer.georaster = georaster;
        tiffLayer.layerName = layerName;
        tiffLayer.minValue = min;
        tiffLayer.maxValue = max;
        
        // Adicionar ao mapa
        tiffLayer.addTo(map);
        
        // Adicionar ao controle de camadas
        overlayLayers[`Interpolação: ${layerName}`] = tiffLayer;
        
        // Atualizar controle de camadas
        if (layerControl) {
            layerControl.remove();
        }
        layerControl = L.control.layers(baseLayers, overlayLayers, {
            collapsed: true,
            position: 'topright'
        }).addTo(map);
        
        // Ajustar zoom se necessário
        if (tiffLayer.getBounds && tiffLayer.getBounds().isValid()) {
            map.fitBounds(tiffLayer.getBounds(), { padding: [50, 50] });
        }
        
        console.log(`✅ TIFF carregado: ${layerName}`);
        
    } catch (error) {
        console.error(`❌ Erro ao carregar TIFF ${tiffUrl}:`, error);
        showStatus(`Erro ao carregar TIFF ${layerName}: ${error.message}`, 'error');
    }
}

// Event listener para upload de shapefile de limites
document.getElementById('boundary-shapefile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const infoDiv = document.getElementById('boundary-shapefile-info');
    infoDiv.textContent = `Carregando: ${file.name}...`;
    infoDiv.classList.remove('hidden');
    
    const formData = new FormData();
    formData.append('shapefile', file);
    
    try {
        const response = await fetch('/api/upload-boundary-shapefile', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            boundaryShapefilePath = result.shapefilePath;
            infoDiv.textContent = `✓ Shapefile carregado: ${file.name}`;
            infoDiv.className = 'file-info';
            showStatus('Shapefile de limites carregado com sucesso!', 'success');
        } else {
            infoDiv.textContent = `Erro: ${result.error}`;
            infoDiv.className = 'file-info';
            showStatus('Erro ao carregar shapefile de limites: ' + result.error, 'error');
        }
    } catch (error) {
        infoDiv.textContent = `Erro: ${error.message}`;
        infoDiv.className = 'file-info';
        showStatus('Erro ao carregar shapefile: ' + error.message, 'error');
    }
});

// Função para mostrar loading
function showLoading(message = 'Gerando Relatório PDF...', submessage = 'Isso pode levar alguns instantes') {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    const subtext = document.getElementById('loading-subtext');
    
    text.textContent = message;
    subtext.textContent = submessage;
    overlay.classList.add('active');
}

// Função para ocultar loading
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('active');
}

// Event listener para botão de gerar relatório
document.getElementById('generate-report-btn').addEventListener('click', async () => {
    if (!interpolationResults) {
        showStatus('Faça a interpolação primeiro!', 'error');
        return;
    }

    const statusDiv = document.getElementById('report-status');
    statusDiv.textContent = 'Gerando relatório PDF...';
    statusDiv.className = 'status info';
    statusDiv.classList.remove('hidden');

    document.getElementById('generate-report-btn').disabled = true;
    
    // Mostrar loading overlay
    showLoading('Gerando Relatório PDF...', 'Processando dados e gerando PDF. Por favor, aguarde...');

    try {
        // Obter informações dos campos de input
        const propertyName = document.getElementById('report-property-name').value || 'Ponte de Pedra';
        const ownerName = document.getElementById('report-owner-name').value || propertyName;
        const plotName = document.getElementById('report-plot-name').value || 'Todos os Talhões';
        const cropSeason = document.getElementById('report-crop-season').value || '24/25';
        const depth = document.getElementById('report-depth').value || '0-20 cm';

        // Calcular área aproximada (pode ser melhorado)
        let area = 0;
        if (mergedGeoJson && mergedGeoJson.features.length > 0) {
            // Estimativa simples baseada no número de pontos
            area = mergedGeoJson.features.length * 0.5; // Aproximação
        }

        const response = await fetch('/api/generate-report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                propertyName: propertyName,
                ownerName: ownerName,
                plotName: plotName,
                cropSeason: cropSeason,
                depth: depth,
                area: area,
                interpolations: interpolationResults.interpolations,
                tiffFiles: interpolationResults.tiffFiles,
                boundaryShapefile: boundaryShapefilePath
            })
        });

        // Verificar se a resposta é JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('Resposta não é JSON:', text.substring(0, 200));
            throw new Error('Resposta do servidor não é JSON. Verifique o console do servidor.');
        }

        // Verificar se a resposta é um PDF (download) ou JSON (erro)
        const contentType = response.headers.get('content-type');
        
        if (contentType && contentType.includes('application/pdf')) {
            // PDF foi retornado como download
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Obter nome do arquivo do header ou usar padrão
            const contentDisposition = response.headers.get('content-disposition');
            let filename = 'relatorio_fertilidade.pdf';
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
                if (filenameMatch) {
                    filename = filenameMatch[1];
                }
            }
            
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            // Atualizar loading com mensagem de sucesso
            showLoading('Relatório Baixado!', 'O PDF foi salvo na pasta de downloads');
            
            // Pequeno delay para mostrar mensagem de sucesso
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            hideLoading();
            
            statusDiv.textContent = 'Relatório gerado e baixado com sucesso!';
            statusDiv.className = 'status success';
        } else {
            // Resposta não é PDF, tentar ler como JSON
            try {
                const result = await response.json();
                
                if (result.success) {
                    // Fallback: se ainda retornar JSON com sucesso, tentar baixar pelo path
                    if (result.pdfPath) {
                        // Fazer download do PDF via URL
                        const downloadUrl = result.pdfPath;
                        const a = document.createElement('a');
                        a.href = downloadUrl;
                        a.download = downloadUrl.split('/').pop() || 'relatorio_fertilidade.pdf';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        
                        showLoading('Relatório Baixado!', 'O PDF foi salvo na pasta de downloads');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        hideLoading();
                        
                        statusDiv.textContent = 'Relatório gerado e baixado com sucesso!';
                        statusDiv.className = 'status success';
                    } else {
                        hideLoading();
                        statusDiv.textContent = 'Relatório gerado com sucesso!';
                        statusDiv.className = 'status success';
                    }
                } else {
                    hideLoading();
                    statusDiv.textContent = 'Erro: ' + result.error;
                    statusDiv.className = 'status error';
                }
            } catch (jsonError) {
                // Se não conseguir fazer parse JSON, a resposta pode ser texto ou PDF
                const responseText = await response.text();
                hideLoading();
                statusDiv.textContent = 'Erro ao processar resposta do servidor: ' + jsonError.message;
                statusDiv.className = 'status error';
                console.error('Resposta do servidor:', responseText.substring(0, 500));
            }
        }
    } catch (error) {
        hideLoading();
        statusDiv.textContent = 'Erro ao gerar relatório: ' + error.message;
        statusDiv.className = 'status error';
    } finally {
        document.getElementById('generate-report-btn').disabled = false;
    }
});

// Inicializar quando a página carregar
window.addEventListener('DOMContentLoaded', () => {
    initMap();
});
