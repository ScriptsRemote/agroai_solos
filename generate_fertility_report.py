#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script para gerar relatório PDF de fertilidade do solo
Baseado na estrutura do PDF de referência "Ponte de Pedra - Fertilidade Safra 24_25.pdf"
"""
import os
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

# Configurar encoding UTF-8 para Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

try:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.utils import ImageReader
    from reportlab.lib import colors
    from reportlab.lib.units import cm
    import rasterio
    from rasterio.mask import mask
    import geopandas as gpd
    from PIL import Image as PILImage, ImageDraw, ImageFont
    import numpy as np
    import io
    from matplotlib import pyplot as plt
    from matplotlib.colors import ListedColormap
    import matplotlib.patches as mpatches
except ImportError as e:
    import json
    error_msg = {
        "error": f"Erro ao importar bibliotecas: {e}",
        "message": "Instale as dependências: pip install reportlab rasterio pillow numpy geopandas matplotlib"
    }
    print(json.dumps(error_msg))
    sys.exit(1)


def calculate_area_hectares(shape_path):
    """Calcula área em hectares do shapefile"""
    try:
        gdf = gpd.read_file(shape_path)
        # Reprojetar para UTM para cálculo preciso
        if gdf.crs != 'EPSG:4326':
            gdf = gdf.to_crs('EPSG:4326')
        
        # Calcular área em graus² e converter para hectares
        area_deg2 = gdf.geometry.area.sum()
        # Aproximação: 1 grau² ≈ 111.32 km × 111.32 km (na latitude do Brasil)
        # Mais preciso: usar projeção UTM
        center_lat = gdf.geometry.centroid.y.mean()
        lat_rad = np.radians(center_lat)
        m_per_deg_lat = 111320
        m_per_deg_lon = 111320 * np.cos(lat_rad)
        area_m2 = area_deg2 * m_per_deg_lat * m_per_deg_lon
        area_ha = area_m2 / 10000
        return round(area_ha, 2)
    except:
        return 0.0


def create_classified_map(tiff_path, num_classes=8, boundary_shapefile=None):
    """Cria mapa classificado com classes de cores e calcula áreas"""
    import json
    from shapely.geometry import mapping
    
    with rasterio.open(tiff_path) as src:
        # Recortar TIFF pelo shapefile de limites se fornecido
        if boundary_shapefile and os.path.exists(boundary_shapefile):
            try:
                print(json.dumps({"info": f"Iniciando recorte do TIFF com shapefile: {boundary_shapefile}"}))
                
                # Carregar shapefile de limites
                gdf = gpd.read_file(boundary_shapefile)
                print(json.dumps({"info": f"Shapefile carregado: {len(gdf)} features, CRS: {gdf.crs}"}))
                print(json.dumps({"info": f"TIFF CRS: {src.crs}"}))
                
                # Reprojetar para o CRS do TIFF se necessário
                if gdf.crs != src.crs:
                    print(json.dumps({"info": f"Reprojetando shapefile de {gdf.crs} para {src.crs}"}))
                    gdf = gdf.to_crs(src.crs)
                
                # Usar a geometria diretamente do GeoDataFrame (rasterio.mask aceita isso)
                # Se houver múltiplas features, unir todas
                try:
                    # Tentar usar union_all() (versões mais recentes do GeoPandas)
                    if len(gdf) > 1:
                        geom = gdf.geometry.union_all()
                    else:
                        geom = gdf.geometry.iloc[0]
                except AttributeError:
                    # Fallback para versões antigas
                    if len(gdf) > 1:
                        geom = gdf.geometry.unary_union
                    else:
                        geom = gdf.geometry.iloc[0]
                
                # Converter para formato GeoJSON para rasterio.mask
                geom_dict = [mapping(geom)]
                
                print(json.dumps({"info": f"Geometria preparada para recorte, tipo: {type(geom)}"}))
                
                # Recortar o raster usando a máscara
                try:
                    # Usar nodata apropriado baseado no dtype do TIFF
                    nodata_value = np.nan if src.dtypes[0] in ['float32', 'float64'] else 0
                    
                    print(json.dumps({"info": f"Recortando TIFF com crop=True, nodata={nodata_value}"}))
                    data_masked, transform_masked = mask(src, geom_dict, crop=True, nodata=nodata_value, all_touched=False)
                    
                    data = data_masked[0]  # Primeira banda
                    transform = transform_masked
                    
                    # APLICAR MÁSCARA ADICIONAL: Garantir que pixels fora do polígono sejam NaN
                    # O rasterio.mask com crop=True apenas recorta a bounding box, não remove pixels fora do polígono
                    # Precisamos aplicar uma máscara adicional pixel a pixel
                    print(json.dumps({"info": f"Aplicando máscara adicional para garantir recorte preciso..."}))
                    
                    height, width = data.shape
                    
                    # Criar arrays de coordenadas para todos os pixels de forma eficiente
                    # Usar rasterio.transform.xy para obter coordenadas dos cantos dos pixels
                    rows = np.arange(height)
                    cols = np.arange(width)
                    
                    # Criar meshgrid de índices
                    row_grid, col_grid = np.meshgrid(rows, cols, indexing='ij')
                    
                    # Converter índices para coordenadas geográficas (centro dos pixels)
                    lons = np.zeros((height, width))
                    lats = np.zeros((height, width))
                    
                    for row in range(height):
                        for col in range(width):
                            lon, lat = rasterio.transform.xy(transform, row, col)
                            lons[row, col] = lon
                            lats[row, col] = lat
                    
                    # Usar shapely.contains_xy para verificação vetorizada (muito mais rápido)
                    try:
                        from shapely import contains_xy
                        # contains_xy aceita arrays numpy diretamente
                        mask_array = contains_xy(geom, lons, lats)
                        print(json.dumps({"info": f"Máscara vetorizada aplicada com sucesso"}))
                    except (ImportError, AttributeError):
                        # Fallback: usar método ponto a ponto (mais lento mas funciona)
                        print(json.dumps({"warning": f"Usando método ponto a ponto (pode ser lento para rasters grandes)..."}))
                        from shapely.geometry import Point
                        mask_array = np.zeros(data.shape, dtype=bool)
                        total_pixels = height * width
                        processed = 0
                        for row in range(height):
                            for col in range(width):
                                point = Point(lons[row, col], lats[row, col])
                                mask_array[row, col] = geom.contains(point)
                                processed += 1
                                if processed % 10000 == 0:
                                    print(json.dumps({"info": f"Processando máscara: {processed}/{total_pixels} pixels ({100*processed/total_pixels:.1f}%)"}))
                    
                    # Aplicar máscara: manter apenas pixels dentro do polígono
                    pixels_antes = np.sum(~np.isnan(data))
                    data = np.where(mask_array, data, nodata_value)
                    pixels_depois = np.sum(~np.isnan(data))
                    
                    print(json.dumps({"info": f"Máscara aplicada: {pixels_antes} -> {pixels_depois} pixels válidos"}))
                    print(json.dumps({"info": f"TIFF recortado com sucesso! Tamanho original: {src.width}x{src.height}, Recortado: {data.shape[1]}x{data.shape[0]}"}))
                except Exception as e:
                    import traceback
                    error_details = traceback.format_exc()
                    print(json.dumps({"error": f"Erro ao recortar TIFF: {str(e)}", "traceback": error_details}))
                    print(json.dumps({"warning": f"Usando TIFF completo devido ao erro"}))
                    data = src.read(1)
                    transform = src.transform
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                print(json.dumps({"error": f"Erro ao processar shapefile de limites: {str(e)}", "traceback": error_details}))
                print(json.dumps({"warning": f"Usando TIFF completo devido ao erro"}))
                data = src.read(1)
                transform = src.transform
        else:
            # Sem shapefile de limites, usar TIFF completo
            if boundary_shapefile:
                print(json.dumps({"warning": f"Shapefile de limites fornecido mas não encontrado: {boundary_shapefile}"}))
            data = src.read(1)
            transform = src.transform
        
        bounds = src.bounds
        crs = src.crs
        
        # Filtrar valores válidos
        valid_data = data[~np.isnan(data)]
        if len(valid_data) == 0:
            return None, None, None, None
        
        min_val = np.nanmin(valid_data)
        max_val = np.nanmax(valid_data)
        
        # Criar classes usando percentis
        percentiles = np.linspace(0, 100, num_classes + 1)
        class_breaks = np.percentile(valid_data, percentiles)
        
        # Classificar dados
        classified = np.digitize(data, class_breaks[1:], right=True)
        classified[np.isnan(data)] = -1
        
        # Calcular área de cada classe
        pixel_area_m2 = abs(transform[0] * transform[4])  # Resolução do pixel em m²
        pixel_area_ha = pixel_area_m2 / 10000
        
        class_areas = {}
        total_pixels = 0
        for i in range(num_classes):
            pixels = np.sum(classified == i)
            area_ha = pixels * pixel_area_ha
            class_areas[i] = {
                'min': class_breaks[i],
                'max': class_breaks[i+1] if i < num_classes-1 else max_val,
                'area_ha': area_ha,
                'pixels': pixels
            }
            total_pixels += pixels
        
        # Calcular percentuais
        total_area_ha = sum(c['area_ha'] for c in class_areas.values())
        for i in class_areas:
            class_areas[i]['percent'] = (class_areas[i]['area_ha'] / total_area_ha * 100) if total_area_ha > 0 else 0
        
        # Criar imagem colorida (RdYlGn)
        rgb = np.zeros((data.shape[0], data.shape[1], 3), dtype=np.uint8)
        cmap = plt.get_cmap('RdYlGn')
        
        for i in range(num_classes):
            class_mask = classified == i
            # Normalizar para colormap (inverter para RdYlGn: verde=alto, vermelho=baixo)
            t = 1.0 - (i / (num_classes - 1)) if num_classes > 1 else 0.5
            color = cmap(t)
            rgb[class_mask] = [int(c * 255) for c in color[:3]]
        
        # Fundo branco para NaN (área fora dos limites após recorte)
        # Isso garante que apenas a área dentro dos limites seja colorida
        nan_mask = np.isnan(data)
        rgb[nan_mask] = [255, 255, 255]  # Branco para área fora dos limites
        rgb[classified == -1] = [255, 255, 255]  # Também branco para classificados como -1
        
        # Carregar shapefile de limites para desenhar bordas (opcional, já que o TIFF foi recortado)
        boundary_coords = None
        if boundary_shapefile and os.path.exists(boundary_shapefile):
            try:
                gdf = gpd.read_file(boundary_shapefile)
                # Reprojetar para o CRS do TIFF se necessário
                if gdf.crs != crs:
                    gdf = gdf.to_crs(crs)
                
                # Converter geometrias para coordenadas do raster (usando transform do TIFF recortado)
                
                # Obter primeira geometria (ou unir todas)
                try:
                    # Tentar usar union_all() (versões mais recentes do GeoPandas)
                    if len(gdf) > 1:
                        geom = gdf.geometry.union_all()
                    else:
                        geom = gdf.geometry.iloc[0]
                except AttributeError:
                    # Fallback para versões antigas
                    if len(gdf) > 1:
                        geom = gdf.geometry.unary_union
                    else:
                        geom = gdf.geometry.iloc[0]
                geom_dict = mapping(geom)
                
                # Transformar para coordenadas do raster (usando o transform do TIFF recortado)
                boundary_coords = []
                if geom_dict['type'] == 'Polygon':
                    for ring in geom_dict['coordinates']:
                        coords = []
                        for lon, lat in ring:
                            # Converter lon/lat para índices do raster recortado
                            row, col = rasterio.transform.rowcol(transform, lon, lat)
                            # Verificar se está dentro dos bounds do raster recortado
                            if 0 <= row < data.shape[0] and 0 <= col < data.shape[1]:
                                coords.append((col, row))
                        if len(coords) > 0:
                            boundary_coords.append(coords)
                elif geom_dict['type'] == 'MultiPolygon':
                    for poly in geom_dict['coordinates']:
                        for ring in poly:
                            coords = []
                            for lon, lat in ring:
                                row, col = rasterio.transform.rowcol(transform, lon, lat)
                                if 0 <= row < data.shape[0] and 0 <= col < data.shape[1]:
                                    coords.append((col, row))
                            if len(coords) > 0:
                                boundary_coords.append(coords)
            except Exception as e:
                print(json.dumps({"warning": f"Erro ao carregar shapefile de limites para desenhar bordas: {str(e)}"}))
        
        return PILImage.fromarray(rgb), class_areas, (min_val, max_val, np.nanmean(valid_data)), boundary_coords


def create_fertility_map_page(
    c, 
    tiff_path, 
    param_name,
    property_name,
    owner_name,
    crop_season,
    depth,
    area_ha,
    statistics,
    logo_path=None,
    boundary_shapefile=None
):
    """Cria uma página de mapa de fertilidade EXATAMENTE igual ao PDF de referência"""
    import json
    
    # Verificar se o arquivo TIFF existe
    if not os.path.exists(tiff_path):
        print(json.dumps({"error": f"Arquivo TIFF não encontrado: {tiff_path}"}))
        return False
    
    width, height = A4
    margin = 1.5*cm
    
    # Cores
    green_dark = colors.HexColor('#2d5016')
    green_light = colors.HexColor('#6b8f47')
    
    # === CABEÇALHO (igual ao PDF de referência) ===
    y_top = height - margin
    
    # Logo (esquerda, topo)
    if logo_path and os.path.exists(logo_path):
        try:
            logo = ImageReader(logo_path)
            logo_w, logo_h = logo.getSize()
            logo_scale = 2.5*cm / max(logo_w, logo_h)
            c.drawImage(logo, margin, y_top - 2*cm, 
                       width=logo_w*logo_scale, height=logo_h*logo_scale,
                       preserveAspectRatio=True)
        except:
            pass
    
    # Título do relatório (centro, topo)
    c.setFont("Helvetica-Bold", 16)
    c.setFillColor(green_dark)
    c.drawCentredString(width/2, y_top - 0.5*cm, "Mapa Fertilidade do Solo")
    
    # Caixas de informações da fazenda (ESQUERDA, alinhadas com o mapa, lado a lado)
    farm_info_y = y_top - 2.5*cm
    farm_box_h = 1.2*cm
    farm_box_w = 8*cm
    farm_box_spacing = 0.3*cm
    
    # Alinhar à esquerda (mesma margem do mapa)
    farm_box_x = margin  # Alinhado com a margem esquerda (mesma do mapa)
    
    # Caixa Fazenda (esquerda)
    farm_box_bottom_y = farm_info_y - farm_box_h
    c.setStrokeColor(colors.black)
    c.setFillColor(colors.white)
    c.rect(farm_box_x, farm_box_bottom_y, farm_box_w, farm_box_h, fill=1, stroke=1)
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.black)
    c.drawString(farm_box_x + 0.3*cm, farm_info_y - 0.7*cm, f"Fazenda: {property_name}")
    
    # Caixa Proprietário (ao lado da caixa Fazenda, MESMA ALTURA Y)
    owner_box_x = farm_box_x + farm_box_w + farm_box_spacing
    owner_box_bottom_y = farm_box_bottom_y  # MESMA posição Y para alinhamento perfeito
    owner_box_right = owner_box_x + farm_box_w  # Lado direito da caixa do proprietário
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.black)
    c.rect(owner_box_x, owner_box_bottom_y, farm_box_w, farm_box_h, fill=1, stroke=1)
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.black)
    c.drawString(owner_box_x + 0.3*cm, farm_info_y - 0.7*cm, f"Proprietário: {owner_name}")
    
    # Caixa de informações do mapa será movida para a parte inferior do mapa (será desenhada depois)
    
    # === MAPA (grande, centralizado, ocupando mais espaço) ===
    # Posição do mapa: abaixo das caixas de informações, com espaçamento adequado
    # farm_info_y está em y_top - 2.5*cm, então o mapa começa abaixo da caixa
    map_start_y = farm_info_y - farm_box_h - 0.5*cm  # Espaçamento menor para dar mais espaço ao mapa
    
    # Espaço para legenda horizontal abaixo do mapa
    legend_horizontal_height = 2.5*cm  # Altura da legenda horizontal
    
    # Espaço para caixa de informações abaixo do mapa
    info_box_h = 4*cm
    info_box_w = 5*cm
    
    # Espaço para elementos abaixo (escala, norte, data)
    elements_below_height = 3.5*cm
    bottom_margin = 1.5*cm
    
    # Dimensões do mapa - ALINHADO COM AS CAIXAS SUPERIORES E LEGENDA
    # Calcular largura total das caixas superiores (Fazenda + Proprietário)
    farm_box_w = 8*cm
    farm_box_spacing = 0.3*cm
    total_boxes_width = 2 * farm_box_w + farm_box_spacing
    
    # O mapa deve ter a mesma largura que as caixas superiores + legenda (ou usar toda a largura disponível)
    # A legenda abaixo do mapa terá a mesma largura do mapa
    map_width = width - 2*margin  # Usa toda a largura disponível (alinhado com margem)
    
    # Espaço disponível: do topo do mapa até a margem inferior, menos espaço para legenda horizontal, caixa de info e elementos
    map_available_height = map_start_y - bottom_margin - legend_horizontal_height - info_box_h - elements_below_height - 1*cm  # 1cm de espaçamento entre elementos
    map_height = max(map_available_height, 12*cm)  # Mínimo de 12cm de altura
    map_x = margin  # Alinhado à esquerda com a margem (mesma das caixas superiores)
    
    print(json.dumps({"info": f"Dimensoes do mapa: {map_width:.1f} x {map_height:.1f} (disponivel: {width - 2*margin:.1f} x {map_available_height:.1f}, map_start_y: {map_start_y:.1f})"}))
    
    # Carregar e processar TIFF
    try:
        img, class_areas, stats, boundary_coords = create_classified_map(tiff_path, boundary_shapefile=boundary_shapefile)
        if img is None:
            print(json.dumps({"error": f"Nao foi possivel processar TIFF {tiff_path}: dados invalidos"}))
            return False
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(json.dumps({"error": f"Erro ao processar TIFF {tiff_path}: {str(e)}", "traceback": error_details}))
        return False
    
    if img:
        # Redimensionar imagem para ocupar o máximo de espaço disponível, mantendo proporção
        original_size = img.size
        original_w, original_h = original_size
        
        # Calcular escala para ocupar o máximo de espaço disponível
        scale_w = map_width / original_w
        scale_h = map_height / original_h
        scale = min(scale_w, scale_h)  # Usar a menor escala para manter proporção
        
        # Redimensionar imagem usando a escala calculada
        img_w = int(original_w * scale)
        img_h = int(original_h * scale)
        img = img.resize((img_w, img_h), PILImage.Resampling.LANCZOS)
        
        scale_x = scale
        scale_y = scale
        
        print(json.dumps({"info": f"Imagem processada: {img_w}x{img_h} pixels (original: {original_size[0]}x{original_size[1]}, escala: {scale:.3f})"}))
        
        # Alinhar imagem à esquerda (mesma margem das caixas superiores e legenda)
        img_x = map_x  # Alinhado à esquerda com a margem (mesma das caixas)
        # Posicionar imagem verticalmente (começando do topo)
        img_y = map_start_y - img_h
        
        # Converter para buffer
        img_buffer = io.BytesIO()
        img.save(img_buffer, format='PNG')
        img_buffer.seek(0)
        
        # Desenhar imagem
        try:
            c.drawImage(ImageReader(img_buffer), img_x, img_y, width=img_w, height=img_h)
            print(json.dumps({"info": f"Imagem desenhada no PDF: posicao ({img_x:.1f}, {img_y:.1f}), tamanho ({img_w:.1f}, {img_h:.1f})"}))
        except Exception as e:
            print(json.dumps({"error": f"Erro ao desenhar imagem no PDF: {str(e)}"}))
            return False
        
        # Desenhar limites/talhões se fornecido
        if boundary_coords:
            try:
                c.setStrokeColor(colors.black)
                c.setLineWidth(2)
                for ring_coords in boundary_coords:
                    if len(ring_coords) > 1:
                        # Converter coordenadas do raster para coordenadas do PDF
                        pdf_coords = []
                        for col, row in ring_coords:
                            x = img_x + (col * scale_x)
                            y = img_y + img_h - (row * scale_y)  # Inverter Y
                            pdf_coords.append((x, y))
                        
                        # Desenhar polígono usando beginPath (API correta do ReportLab)
                        p = c.beginPath()
                        first = True
                        for x, y in pdf_coords:
                            if first:
                                p.moveTo(x, y)
                                first = False
                            else:
                                p.lineTo(x, y)
                        p.close()  # Fechar o polígono
                        c.drawPath(p, stroke=1, fill=0)
                print(json.dumps({"info": f"Limites desenhados no mapa"}))
            except Exception as e:
                import traceback
                # Se falhar, tentar desenhar apenas com linhas simples
                try:
                    for ring_coords in boundary_coords:
                        if len(ring_coords) > 1:
                            pdf_coords = []
                            for col, row in ring_coords:
                                x = img_x + (col * scale_x)
                                y = img_y + img_h - (row * scale_y)
                                pdf_coords.append((x, y))
                            # Desenhar linhas conectadas
                            for i in range(len(pdf_coords)):
                                x1, y1 = pdf_coords[i]
                                x2, y2 = pdf_coords[(i + 1) % len(pdf_coords)]
                                c.line(x1, y1, x2, y2)
                    print(json.dumps({"info": f"Limites desenhados (metodo alternativo)"}))
                except:
                    print(json.dumps({"warning": f"Erro ao desenhar limites: {str(e)}"}))
        
        # Borda do mapa
        c.setStrokeColor(colors.black)
        c.rect(img_x, img_y, img_w, img_h, stroke=1, fill=0)
    
    # === LEGENDA HORIZONTAL (abaixo do mapa) ===
    # Posição: abaixo do mapa
    legend_y = img_y - 0.5*cm  # Começar logo abaixo do mapa
    legend_h = legend_horizontal_height
    
    # Caixa da legenda horizontal - ALINHADA COM O MAPA E CAIXAS SUPERIORES
    legend_x = margin  # Mesma margem esquerda
    legend_w = map_width  # Mesma largura do mapa (alinhada)
    
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.black)
    c.rect(legend_x, legend_y - legend_h, legend_w, legend_h, fill=1, stroke=1)
    
    # Título da legenda
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(green_dark)
    c.drawString(legend_x + 0.2*cm, legend_y - 0.5*cm, "Legenda")
    
    # Classes da legenda (horizontal, em DUAS LINHAS)
    if class_areas:
        cmap = plt.get_cmap('RdYlGn')
        square_size = 0.4*cm
        classes_list = sorted(class_areas.items())
        num_classes = len(classes_list)
        classes_per_line = (num_classes + 1) // 2  # Dividir em duas linhas
        
        # Primeira linha
        x_offset = 0.5*cm  # Começar após o título
        y_line1 = legend_y - 0.8*cm  # Primeira linha
        y_line2 = legend_y - 1.6*cm  # Segunda linha
        
        for i, (class_idx, class_data) in enumerate(classes_list):
            # Determinar qual linha usar
            if i < classes_per_line:
                y_center = y_line1
            else:
                y_center = y_line2
                # Se mudou de linha, resetar x_offset
                if i == classes_per_line:
                    x_offset = 0.5*cm
            
            # Cor da classe
            t = 1.0 - (class_idx / (num_classes - 1)) if num_classes > 1 else 0.5
            color = cmap(t)
            c.setFillColorRGB(*color[:3])
            
            # Quadrado de cor
            square_x = legend_x + x_offset
            square_y = y_center - square_size/2
            
            # Desenhar quadrado com borda
            c.setStrokeColor(colors.black)
            c.setLineWidth(0.5)
            c.rect(square_x, square_y, square_size, square_size, fill=1, stroke=1)
            
            # Texto da classe (formato: "X.X - Y.Y")
            c.setFont("Helvetica", 8)
            c.setFillColor(colors.black)
            class_text = f"{class_data['min']:.1f} - {class_data['max']:.1f}"
            text_x = square_x + square_size + 0.1*cm
            c.drawString(text_x, y_center - 0.15*cm, class_text)
            
            # Área e percentual (abaixo do texto)
            area_text = f"{class_data['area_ha']:.2f} ha ({class_data['percent']:.1f}%)"
            c.setFont("Helvetica", 7)
            c.drawString(text_x, y_center - 0.4*cm, area_text)
            
            # Avançar para próxima classe (espaçamento horizontal)
            x_offset += 3.0*cm  # Espaçamento entre classes (reduzido para caber em duas linhas)
    
    # === CAIXA DE INFORMAÇÕES DO MAPA (abaixo da legenda) ===
    info_box_y = legend_y - legend_h - 0.3*cm  # Abaixo da legenda com espaçamento
    info_box_x = margin  # Alinhada à esquerda com o mapa
    
    c.setStrokeColor(colors.black)
    c.setFillColor(colors.white)
    c.rect(info_box_x, info_box_y - info_box_h, info_box_w, info_box_h, fill=1, stroke=1)
    
    # Título da caixa
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(green_dark)
    c.drawString(info_box_x + 0.2*cm, info_box_y - 0.5*cm, "Mapa Fertilidade do Solo")
    
    # Informações (espaçamento exato)
    c.setFont("Helvetica", 9)
    c.setFillColor(colors.black)
    info_start_y = info_box_y - 1.0*cm
    line_spacing = 0.7*cm
    c.drawString(info_box_x + 0.2*cm, info_start_y, f"Safra: {crop_season}")
    c.drawString(info_box_x + 0.2*cm, info_start_y - line_spacing, f"Atributo: {param_name}")
    c.drawString(info_box_x + 0.2*cm, info_start_y - 2*line_spacing, f"Profundidade: {depth}")
    c.drawString(info_box_x + 0.2*cm, info_start_y - 3*line_spacing, f"Área Total: {area_ha:.2f} ha")
    
    # === ESTATÍSTICAS (ao lado da caixa de informações) ===
    stats_box_h = 2.5*cm
    stats_box_w = 5*cm
    stats_box_x = info_box_x + info_box_w + 0.5*cm  # Ao lado da caixa de informações
    stats_box_y = info_box_y  # Mesma altura Y
    
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.black)
    c.rect(stats_box_x, stats_box_y - stats_box_h, stats_box_w, stats_box_h, fill=1, stroke=1)
    
    # Título das estatísticas
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(green_dark)
    stats_title_y = stats_box_y - 0.4*cm
    c.drawString(stats_box_x + 0.2*cm, stats_title_y, "Estatísticas")
    
    if stats:
        c.setFont("Helvetica", 9)
        c.setFillColor(colors.black)
        line_height = 0.6*cm
        first_line_y = stats_title_y - 0.5*cm
        c.drawString(stats_box_x + 0.2*cm, first_line_y, f"Mínimo: {stats[0]:.2f}")
        c.drawString(stats_box_x + 0.2*cm, first_line_y - line_height, f"Máximo: {stats[1]:.2f}")
        c.drawString(stats_box_x + 0.2*cm, first_line_y - 2*line_height, f"Média: {stats[2]:.2f}")
    
    # === ELEMENTOS DO MAPA (escala, norte, data) - DENTRO DO MAPA, INFERIOR DIREITA ===
    # Posicionar elementos DENTRO do mapa, na parte inferior direita
    # IMPORTANTE: Garantir que ambos (escala e norte) estejam COMPLETAMENTE dentro do mapa
    
    # Escala (dentro do mapa, canto inferior direito)
    scale_w = 3*cm
    north_size = 1.0*cm  # Tamanho da seta do norte
    spacing = 0.3*cm  # Espaçamento entre escala e norte
    
    # Calcular posição para que ambos caibam dentro do mapa
    total_width = scale_w + spacing + north_size
    scale_x = img_x + img_w - total_width - 0.5*cm  # Dentro do mapa, à direita com margem
    # Posição Y: dentro do mapa, próximo à parte inferior
    scale_y = img_y + 0.8*cm  # Dentro do mapa, próximo ao fundo
    scale_h = 0.3*cm
    
    # Fundo branco para legibilidade (opcional, mas recomendado)
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.white)
    c.rect(scale_x - 0.2*cm, scale_y - 0.3*cm, scale_w + 0.4*cm, 0.8*cm, fill=1, stroke=0)
    
    # Linha da escala
    c.setStrokeColor(colors.black)
    c.setLineWidth(2)
    c.line(scale_x, scale_y, scale_x + scale_w, scale_y)
    # Marcas na escala
    for i in range(5):
        x = scale_x + (i * scale_w / 4)
        c.line(x, scale_y, x, scale_y + 0.1*cm)
    # Texto da escala (formato igual ao PDF de referência)
    c.setFont("Helvetica", 7)
    c.setFillColor(colors.black)
    c.drawString(scale_x, scale_y - 0.4*cm, "0")
    c.drawString(scale_x + scale_w/2, scale_y - 0.4*cm, "925")
    c.drawString(scale_x + scale_w, scale_y - 0.4*cm, "1,850 Metros")
    
    # Seta do Norte (dentro do mapa, à direita da escala, GARANTINDO que está dentro)
    north_x = scale_x + scale_w + spacing  # Ao lado da escala, dentro do mapa
    north_y = scale_y  # Mesma altura Y da escala
    
    # Verificar se a seta do norte está dentro do mapa
    if north_x + north_size > img_x + img_w - 0.3*cm:
        # Se não couber, ajustar posição
        north_x = img_x + img_w - north_size - 0.5*cm
        # E ajustar a escala para não sobrepor
        scale_x = north_x - scale_w - spacing
    
    # Fundo branco para legibilidade
    c.setFillColor(colors.white)
    c.setStrokeColor(colors.white)
    c.rect(north_x - 0.2*cm, north_y - 0.2*cm, 1.0*cm, 1.0*cm, fill=1, stroke=0)
    
    # Círculo
    c.setStrokeColor(colors.black)
    c.circle(north_x + 0.5*cm, north_y + 0.5*cm, 0.4*cm, stroke=1, fill=0)
    # Seta do Norte - desenhar triângulo usando beginPath
    c.setFillColor(colors.black)
    c.setStrokeColor(colors.black)
    # Coordenadas do triângulo
    top_x = north_x + 0.5*cm
    top_y = north_y + 0.9*cm
    left_x = north_x + 0.3*cm
    left_y = north_y + 0.5*cm
    right_x = north_x + 0.7*cm
    right_y = north_y + 0.5*cm
    # Desenhar triângulo usando beginPath (API correta)
    try:
        p = c.beginPath()
        p.moveTo(top_x, top_y)
        p.lineTo(left_x, left_y)
        p.lineTo(right_x, right_y)
        p.close()
        c.drawPath(p, stroke=1, fill=1)
    except:
        # Fallback: apenas linhas
        c.line(top_x, top_y, left_x, left_y)
        c.line(left_x, left_y, right_x, right_y)
        c.line(right_x, right_y, top_x, top_y)
    # N
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(colors.black)
    c.drawCentredString(north_x + 0.5*cm, north_y + 0.3*cm, "N")
    
    # Data de atualização (abaixo da caixa de informações, fora do mapa)
    update_text = f"Mapa Atualizado em: {datetime.now().strftime('%d/%m/%Y %I:%M %p')}"
    c.setFont("Helvetica", 7)
    update_y = info_box_y - info_box_h - 0.3*cm  # Abaixo da caixa de informações
    c.drawString(margin, update_y, update_text)
    
    # Rodapé
    c.setFont("Helvetica", 9)
    c.setFillColor(colors.grey)
    c.drawCentredString(width/2, margin, "Powered by OnAgri (R)")
    
    # Marcar página como criada mesmo se houver avisos nos limites
    return True


def create_fertility_report(
    output_path: str,
    property_name: str,
    owner_name: str,
    plot_name: str,
    crop_season: str,
    depth: str,
    area_hectares: float,
    interpolations: dict,
    tiff_files: dict,
    logo_path: str = None,
    boundary_shapefile: str = None
):
    """Cria relatório PDF de fertilidade do solo usando os TIFFs da interpolação"""
    import json
    
    print(json.dumps({"info": f"Iniciando geração de PDF: {output_path}"}))
    print(json.dumps({"info": f"Parâmetros: {len(tiff_files)} TIFFs, {len(interpolations)} interpolações"}))
    
    # Verificar se há TIFFs válidos
    valid_tiffs = {}
    for param, tiff_path in tiff_files.items():
        if tiff_path and os.path.exists(tiff_path):
            valid_tiffs[param] = tiff_path
            print(json.dumps({"info": f"TIFF válido: {param} -> {tiff_path}"}))
        else:
            print(json.dumps({"warning": f"TIFF não encontrado: {param} -> {tiff_path}"}))
    
    if len(valid_tiffs) == 0:
        error_msg = {"error": "Nenhum arquivo TIFF válido encontrado para gerar o relatório"}
        print(json.dumps(error_msg))
        return False
    
    try:
        c = canvas.Canvas(output_path, pagesize=A4)
        pages_created = 0
        
        # Gerar uma página para cada parâmetro usando os TIFFs da interpolação
        for param, tiff_path in valid_tiffs.items():
            print(json.dumps({"info": f"Processando parâmetro: {param}"}))
            
            # Obter estatísticas da interpolação
            stats_data = interpolations.get(param, {}).get('statistics', {})
            statistics = (
                stats_data.get('min', 0),
                stats_data.get('max', 0),
                stats_data.get('mean', 0)
            )
            
            print(json.dumps({"info": f"Estatísticas {param}: min={statistics[0]}, max={statistics[1]}, mean={statistics[2]}"}))
            
            # Criar página do mapa usando o TIFF da interpolação
            try:
                success = create_fertility_map_page(
                    c, tiff_path, param, property_name, owner_name,
                    crop_season, depth, area_hectares, statistics, logo_path, boundary_shapefile
                )
                
                if success:
                    pages_created += 1
                    c.showPage()
                    print(json.dumps({"info": f"Página criada para {param}"}))
                else:
                    print(json.dumps({"warning": f"Falha ao criar página para {param}"}))
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                print(json.dumps({"error": f"Erro ao criar pagina para {param}: {str(e)}", "traceback": error_details}))
                # Continuar com próximo parâmetro mesmo em caso de erro
                # Mas não incrementar pages_created se falhou
        
        if pages_created == 0:
            error_msg = {"error": "Nenhuma página foi criada no PDF"}
            print(json.dumps(error_msg))
            return False
        
        c.save()
        
        # Verificar se o arquivo foi criado
        if not os.path.exists(output_path):
            error_msg = {"error": f"PDF não foi criado em {output_path}"}
            print(json.dumps(error_msg))
            return False
        
        file_size = os.path.getsize(output_path)
        result = {
            "success": True,
            "message": f"PDF gerado com sucesso: {output_path}",
            "output_path": output_path,
            "pages": pages_created,
            "file_size": file_size
        }
        print(json.dumps(result))
        return True
        
    except Exception as e:
        error_msg = {
            "error": f"Erro ao gerar PDF: {str(e)}",
            "traceback": str(e.__class__.__name__)
        }
        print(json.dumps(error_msg))
        import traceback
        traceback.print_exc()
        return False


def main():
    parser = argparse.ArgumentParser(description='Gerar relatório PDF de fertilidade do solo')
    parser.add_argument('--output', required=True, help='Caminho do arquivo PDF de saída')
    parser.add_argument('--property-name', required=True, help='Nome da propriedade')
    parser.add_argument('--owner-name', default='', help='Nome do proprietário')
    parser.add_argument('--plot-name', required=True, help='Nome do talhão')
    parser.add_argument('--crop-season', default='24/25', help='Safra (ex: 24/25)')
    parser.add_argument('--depth', default='0-20 cm', help='Profundidade')
    parser.add_argument('--area', type=float, default=0.0, help='Área em hectares')
    parser.add_argument('--interpolations', required=True, help='JSON com estatísticas das interpolações')
    parser.add_argument('--tiff-files', required=True, help='JSON com caminhos dos arquivos TIFF')
    parser.add_argument('--logo', help='Caminho do logo (opcional)')
    parser.add_argument('--boundary-shapefile', help='Caminho do shapefile de limites/talhões (opcional)')
    
    args = parser.parse_args()
    
    # Carregar dados JSON
    try:
        interpolations = json.loads(args.interpolations)
        tiff_files = json.loads(args.tiff_files)
        print(json.dumps({"info": f"Carregados {len(interpolations)} interpolacoes e {len(tiff_files)} arquivos TIFF"}))
    except json.JSONDecodeError as e:
        error_msg = {"error": f"Erro ao decodificar JSON: {e}"}
        print(json.dumps(error_msg))
        sys.exit(1)
    
    # Criar diretório se não existir
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    
    # Gerar relatório
    success = create_fertility_report(
        output_path=args.output,
        property_name=args.property_name,
        owner_name=args.owner_name,
        plot_name=args.plot_name,
        crop_season=args.crop_season,
        depth=args.depth,
        area_hectares=args.area,
        interpolations=interpolations,
        tiff_files=tiff_files,
        logo_path=args.logo,
        boundary_shapefile=args.boundary_shapefile
    )
    
    if not success:
        print(json.dumps({"error": "Falha ao gerar relatorio PDF"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
