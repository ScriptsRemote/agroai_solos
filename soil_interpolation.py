#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script de Interpolação de Dados de Solo
Baseado no ConnecFarm - Sistema de Análise de Solo

Este script processa arquivos GeoJSON contendo dados de solo
e gera interpolações usando métodos de Krigagem e IDW.
"""

import sys
import json
import numpy as np
import pandas as pd
import argparse
from pathlib import Path
from typing import Tuple, Optional
import logging

# Configurar logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    import geopandas as gpd
    import matplotlib.pyplot as plt
    import matplotlib.colors as mcolors
    from matplotlib.colors import LinearSegmentedColormap
    from scipy.interpolate import griddata
    from scipy.spatial.distance import cdist
    from scipy.spatial import cKDTree
    import rasterio
    from rasterio.transform import from_origin, from_bounds
    from rasterio.features import rasterize
    import fiona
    import shapely.geometry as sgeom
    from shapely.geometry import Point, Polygon
    
    # Tentar importar pykrige para Krigagem
    try:
        from pykrige.ok import OrdinaryKriging
        PYKRIGE_AVAILABLE = True
        logger.info("✅ PyKrige disponível - Krigagem otimizada ativada")
    except ImportError:
        PYKRIGE_AVAILABLE = False
        logger.warning("⚠️ PyKrige não disponível - usando fallback sklearn")
        from sklearn.gaussian_process import GaussianProcessRegressor
        from sklearn.gaussian_process.kernels import RBF, ConstantKernel
        from sklearn.preprocessing import StandardScaler
except ImportError as e:
    logger.error(f"Erro ao importar bibliotecas: {e}")
    logger.error("Instale as dependências: pip install geopandas matplotlib scipy scikit-learn rasterio fiona shapely pykrige")
    sys.exit(1)


class SoilInterpolation:
    """
    Classe para interpolação de dados de solo usando Krigagem e IDW
    """
    
    def __init__(self, resolution: float = 10.0, search_radius: float = 100.0, use_mask: bool = False):
        self.resolution = resolution  # metros
        self.search_radius = search_radius  # metros
        self.use_mask = use_mask  # aplicar máscara da área ou interpolar tudo (padrão: False para cobrir tudo)
        self.data = None
        self.bounds = None
        self.area_polygon = None
        
    def load_geojson(self, geojson_data: dict) -> bool:
        """Carrega dados do GeoJSON (dict ou string)"""
        try:
            # Se for string, fazer parse
            if isinstance(geojson_data, str):
                geojson_data = json.loads(geojson_data)
            
            # Converter para GeoDataFrame
            self.data = gpd.GeoDataFrame.from_features(geojson_data.get('features', []), crs='EPSG:4326')
            
            # Verificar se há pontos
            if self.data.empty or not any(self.data.geometry.geom_type == 'Point'):
                logger.error("GeoJSON deve conter pontos (Point geometries)")
                return False
            
            # Calcular bounds dos pontos
            self.bounds = self.data.total_bounds  # [minx, miny, maxx, maxy]
            
            # Criar polígono da área usando convex hull
            # Usar union_all() em vez de unary_union (deprecated)
            try:
                points_union = self.data.geometry.union_all()
            except AttributeError:
                # Fallback para versões antigas do GeoPandas
                points_union = self.data.geometry.unary_union
            self.area_polygon = points_union.convex_hull
            
            total_points = len(self.data)
            logger.info(f"📊 Total de pontos carregados: {total_points}")
            logger.info(f"Bounds: {self.bounds}")
            
            return True
            
        except Exception as e:
            logger.error(f"Erro ao carregar GeoJSON: {e}")
            return False
    
    def interpolate_parameter(self, parameter: str, method: str = 'kriging'):
        """
        Interpola um parâmetro específico
        
        Returns:
            X_grid, Y_grid, Z_interpolated
        """
        # Extrair valores do parâmetro
        if parameter not in self.data.columns:
            raise ValueError(f"Parâmetro '{parameter}' não encontrado nos dados")
        
        # Filtrar dados válidos e converter para numérico
        total_points_before = len(self.data)
        
        # Primeiro, tentar converter a coluna para numérico
        self.data[parameter] = pd.to_numeric(self.data[parameter], errors='coerce')
        
        # Filtrar apenas valores numéricos válidos (não NaN)
        valid_data = self.data[self.data[parameter].notna()].copy()
        
        points_with_value = len(valid_data)
        points_without_value = total_points_before - points_with_value
        
        logger.info(f"📊 Estatísticas de pontos para {parameter}:")
        logger.info(f"   Total de pontos no dataset: {total_points_before}")
        logger.info(f"   Pontos com valor válido: {points_with_value}")
        logger.info(f"   Pontos sem valor (excluídos): {points_without_value}")
        logger.info(f"   Percentual usado: {(points_with_value/total_points_before*100):.1f}%")
        
        if len(valid_data) < 3:
            raise ValueError(f"Dados insuficientes para '{parameter}' (mínimo 3 pontos). Encontrados: {len(valid_data)} pontos válidos de {total_points_before} total")
        
        # Extrair coordenadas e valores
        coords = np.column_stack([valid_data.geometry.x, valid_data.geometry.y])
        values = valid_data[parameter].values.astype(float)  # Garantir que são floats
        
        logger.info(f"✅ Usando {len(valid_data)} pontos para interpolação de {parameter}")
        logger.info(f"   Valores: min={values.min():.3f}, max={values.max():.3f}, média={values.mean():.3f}")
        logger.info(f"   Coordenadas: {coords.shape} pontos")
        
        # Criar grid regular
        # Usar bounds de TODOS os pontos (não apenas os válidos) para garantir cobertura completa
        all_points_bounds = self.data.total_bounds  # [minx, miny, maxx, maxy]
        x_min, y_min, x_max, y_max = all_points_bounds
        
        # Expandir bounds significativamente para garantir que cubra todos os pontos
        # Calcular buffer baseado na maior dimensão
        x_range = x_max - x_min
        y_range = y_max - y_min
        max_range = max(x_range, y_range)
        
        # Buffer maior (20% da maior dimensão, mínimo 0.001 graus)
        buffer = max(max_range * 0.2, 0.001)
        
        x_min -= buffer
        x_max += buffer
        y_min -= buffer
        y_max += buffer
        
        logger.info(f"📐 Bounds expandidos:")
        logger.info(f"   Original: [{all_points_bounds[0]:.6f}, {all_points_bounds[1]:.6f}, {all_points_bounds[2]:.6f}, {all_points_bounds[3]:.6f}]")
        logger.info(f"   Expandido: [{x_min:.6f}, {y_min:.6f}, {x_max:.6f}, {y_max:.6f}]")
        logger.info(f"   Buffer aplicado: {buffer:.6f} graus ({buffer * 111320:.1f} metros)")
        
        # Calcular número de células baseado na resolução
        # Conversão aproximada: 1 grau ≈ 111320 metros
        resolution_deg = self.resolution / 111320  # Resolução em graus
        
        # Garantir número mínimo de células para boa qualidade
        min_cells = 100
        x_cells = max(int((x_max - x_min) / resolution_deg), min_cells)
        y_cells = max(int((y_max - y_min) / resolution_deg), min_cells)
        
        # Limitar número máximo de células para evitar problemas de memória
        max_cells = 2000
        x_cells = min(x_cells, max_cells)
        y_cells = min(y_cells, max_cells)
        
        logger.info(f"📐 Grid de interpolação: {x_cells}x{y_cells} células")
        logger.info(f"   Resolução: {self.resolution}m ({resolution_deg:.6f} graus)")
        
        x_grid = np.linspace(x_min, x_max, x_cells)
        y_grid = np.linspace(y_min, y_max, y_cells)
        X_grid, Y_grid = np.meshgrid(x_grid, y_grid)
        
        # Interpolar usando métodos
        if method.lower() == 'kriging':
            Z_interpolated = self._kriging_interpolation(coords, values, X_grid, Y_grid)
        else:  # IDW
            Z_interpolated = self._idw_interpolation(coords, values, X_grid, Y_grid)
        
        logger.info(f"Interpolação concluída: valores entre {Z_interpolated.min():.3f} e {Z_interpolated.max():.3f}")
        
        return X_grid, Y_grid, Z_interpolated
    
    def _kriging_interpolation(self, coords: np.ndarray, values: np.ndarray,
                              X_grid: np.ndarray, Y_grid: np.ndarray) -> np.ndarray:
        """Interpolação usando Krigagem com PyKrige"""
        try:
            logger.info(f"Iniciando Krigagem com {len(coords)} pontos")
            
            if len(coords) < 3:
                logger.warning("Poucos pontos para Krigagem, usando IDW")
                return self._idw_interpolation(coords, values, X_grid, Y_grid, 2.0)
            
            # Usar PyKrige se disponível
            if PYKRIGE_AVAILABLE:
                logger.info("🚀 Usando PyKrige para Krigagem")
                
                x = coords[:, 0]
                y = coords[:, 1]
                
                OK = OrdinaryKriging(
                    x, y, values,
                    variogram_model="spherical",
                    verbose=False,
                    enable_plotting=False,
                    nlags=min(6, len(x) // 2),
                    weight=True
                )
                
                # Executar krigagem no grid
                z, _ = OK.execute("grid", X_grid[0, :], Y_grid[:, 0])
                
                logger.info(f"PyKrige Krigagem concluída: min={z.min():.3f}, max={z.max():.3f}")
                
                return np.array(z)
            else:
                # Fallback para sklearn
                logger.info("📦 Usando sklearn como fallback")
                scaler = StandardScaler()
                coords_scaled = scaler.fit_transform(coords)
                
                kernel = ConstantKernel(1.0, (1e-2, 1e2)) * RBF(
                    np.std(coords_scaled, axis=0),
                    (np.maximum(np.std(coords_scaled, axis=0) * 0.1, 1e-3),
                     np.maximum(np.std(coords_scaled, axis=0) * 10, 1e-2))
                )
                
                gpr = GaussianProcessRegressor(
                    kernel=kernel,
                    random_state=42,
                    alpha=1e-8,
                    normalize_y=False,
                    n_restarts_optimizer=10
                )
                
                gpr.fit(coords_scaled, values)
                
                grid_points = np.column_stack([X_grid.ravel(), Y_grid.ravel()])
                grid_points_scaled = scaler.transform(grid_points)
                
                predicted, _ = gpr.predict(grid_points_scaled, return_std=True)
                
                return predicted.reshape(X_grid.shape)
            
        except Exception as e:
            logger.error(f"Erro na Krigagem: {e}")
            logger.info("Usando IDW como fallback")
            return self._idw_interpolation(coords, values, X_grid, Y_grid, 2.0)
    
    def _idw_interpolation(self, coords: np.ndarray, values: np.ndarray,
                          X_grid: np.ndarray, Y_grid: np.ndarray, power: float = 2.0) -> np.ndarray:
        """Interpolação usando IDW (Inverse Distance Weighting) otimizado"""
        try:
            logger.info(f"Iniciando IDW otimizado com {len(coords)} pontos")
            
            # Usar cKDTree para busca eficiente
            tree = cKDTree(coords)
            pts_dst = np.column_stack([X_grid.ravel(), Y_grid.ravel()])
            
            # Buscar k vizinhos mais próximos (aumentar k para melhor cobertura)
            # Usar mais vizinhos para garantir que todos os pontos sejam considerados
            k = min(max(15, len(coords) // 5), len(coords))  # Mínimo 15, máximo todos os pontos
            dists, idxs = tree.query(pts_dst, k=k, workers=-1)
            
            logger.info(f"IDW otimizado: usando {k} vizinhos mais próximos de {len(coords)} pontos disponíveis")
            
            # Garantir formato correto
            if k == 1 or len(coords) == 1:
                dists = dists[:, np.newaxis]
                idxs = idxs[:, np.newaxis]
            
            # Evitar divisão por zero
            dists = np.where(dists == 0, 1e-12, dists)
            
            # Calcular pesos IDW
            weights = 1.0 / (dists ** power)
            weights /= weights.sum(axis=1, keepdims=True)
            
            # Interpolar
            interp = (weights * values[idxs]).sum(axis=1)
            
            logger.info(f"IDW concluído: min={interp.min():.3f}, max={interp.max():.3f}")
            
            return interp.reshape(X_grid.shape)
            
        except Exception as e:
            logger.error(f"Erro no IDW: {e}")
            return np.full(X_grid.shape, np.mean(values))
    
    def save_as_tiff(self, X_grid: np.ndarray, Y_grid: np.ndarray, Z_grid: np.ndarray,
                     output_path: str, parameter: str) -> bool:
        """Salva interpolação como GeoTIFF"""
        try:
            # Aplicar máscara se necessário
            if self.use_mask and self.area_polygon:
                Z_masked = self._apply_mask(X_grid, Y_grid, Z_grid)
            else:
                Z_masked = Z_grid
            
            # Configurar transformação
            x_min, x_max = X_grid.min(), X_grid.max()
            y_min, y_max = Y_grid.min(), Y_grid.max()
            
            transform = from_bounds(x_min, y_min, x_max, y_max, Z_masked.shape[1], Z_masked.shape[0])
            
            # Salvar GeoTIFF
            with rasterio.open(
                output_path,
                'w',
                driver='GTiff',
                height=Z_masked.shape[0],
                width=Z_masked.shape[1],
                count=1,
                dtype=rasterio.float32,
                crs=rasterio.crs.CRS.from_string('+proj=longlat +datum=WGS84 +no_defs'),
                transform=transform,
                compress='lzw',
                nodata=np.nan
            ) as dst:
                dst.write(Z_masked.astype(np.float32), 1)
                dst.set_band_description(1, parameter)
            
            logger.info(f"GeoTIFF salvo: {output_path}")
            logger.info(f"Valores: min={np.nanmin(Z_masked):.3f}, max={np.nanmax(Z_masked):.3f}")
            return True
            
        except Exception as e:
            logger.error(f"Erro ao salvar GeoTIFF: {e}")
            return False
    
    def _apply_mask(self, X_grid: np.ndarray, Y_grid: np.ndarray, Z_grid: np.ndarray) -> np.ndarray:
        """Aplica máscara da área"""
        try:
            # Usar shapely.contains_xy em vez de vectorized.contains (deprecated)
            try:
                from shapely import contains_xy
                points_grid = np.column_stack([X_grid.ravel(), Y_grid.ravel()])
                mask_1d = contains_xy(self.area_polygon, points_grid[:, 0], points_grid[:, 1])
            except ImportError:
                # Fallback para versões antigas
                from shapely.vectorized import contains
                points_grid = np.column_stack([X_grid.ravel(), Y_grid.ravel()])
                mask_1d = contains(self.area_polygon, points_grid[:, 0], points_grid[:, 1])
            
            mask = mask_1d.reshape(Z_grid.shape)
            Z_masked = np.where(mask, Z_grid, np.nan)
            return Z_masked
        except Exception as e:
            logger.warning(f"Erro ao aplicar máscara: {e}")
            return Z_grid


def main():
    """Função principal"""
    parser = argparse.ArgumentParser(description='Interpolação de dados de solo')
    parser.add_argument('--input', required=True, help='Arquivo GeoJSON de entrada')
    parser.add_argument('--parameter', required=True, help='Parâmetro para interpolar')
    parser.add_argument('--method', required=True, choices=['kriging', 'idw'], help='Método de interpolação')
    parser.add_argument('--resolution', type=float, default=10.0, help='Resolução em metros')
    parser.add_argument('--search-radius', type=float, default=100.0, help='Raio de busca em metros')
    parser.add_argument('--output-dir', required=True, help='Diretório de saída')
    parser.add_argument('--no-mask', action='store_true', help='Desabilitar máscara da área')
    
    args = parser.parse_args()
    
    # Criar interpolador (máscara desabilitada por padrão para cobrir toda a área)
    interpolator = SoilInterpolation(
        resolution=args.resolution,
        search_radius=args.search_radius,
        use_mask=False  # Desabilitar máscara por padrão para garantir cobertura completa
    )
    
    # Carregar dados
    with open(args.input, 'r', encoding='utf-8') as f:
        geojson_data = json.load(f)
    
    if not interpolator.load_geojson(geojson_data):
        sys.exit(1)
    
    try:
        # Interpolar
        logger.info(f"Interpolando {args.parameter} usando {args.method}")
        X_grid, Y_grid, Z_grid = interpolator.interpolate_parameter(args.parameter, args.method)
        
        # Caminhos de saída
        output_dir = Path(args.output_dir)
        output_dir.mkdir(exist_ok=True)
        
        tiff_path = output_dir / f"{args.parameter}_{args.method}_interpolation.tif"
        
        # Salvar arquivo
        success = interpolator.save_as_tiff(X_grid, Y_grid, Z_grid, str(tiff_path), args.parameter)
        
        if success:
            # Imprimir estatísticas para o servidor capturar
            valid_values = Z_grid[~np.isnan(Z_grid)]
            if len(valid_values) > 0:
                print(f"STATS: min={valid_values.min():.3f}, max={valid_values.max():.3f}, mean={valid_values.mean():.3f}")
            logger.info("Interpolação concluída com sucesso!")
        else:
            logger.error("Erro ao salvar arquivo")
            sys.exit(1)
            
    except Exception as e:
        logger.error(f"Erro durante interpolação: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
