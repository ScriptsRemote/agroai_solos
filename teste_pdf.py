#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Script de teste para gerar PDF com layout"""
import os
import json
import sys
from pathlib import Path

# Adicionar diretório atual ao path
sys.path.insert(0, os.path.dirname(__file__))

from generate_fertility_report import create_fertility_report

# Caminhos dos arquivos
base_dir = Path(__file__).parent
tiff_path = base_dir / "output" / "Cu_fazenda_idw_20260121.tif"
shape_path = base_dir / "bases" / "Shape_Perímetro" / "fz_ponte_de_pedra.shp"
logo_path = base_dir.parent / "asset" / "Logos-04.png"
from datetime import datetime
pdf_path = base_dir / "reports" / f"teste_layout_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"

# Verificar se arquivos existem
if not tiff_path.exists():
    print(f"❌ TIFF não encontrado: {tiff_path}")
    sys.exit(1)

if not shape_path.exists():
    print(f"❌ Shapefile não encontrado: {shape_path}")
    sys.exit(1)

# Criar diretório de relatórios
pdf_path.parent.mkdir(exist_ok=True)

# Dados de teste
interpolations = {
    "Cu": {
        "statistics": {
            "min": 0.5,
            "max": 5.0,
            "mean": 2.5
        }
    }
}

tiff_files = {
    "Cu": str(tiff_path)
}

# Gerar PDF
print(f"\n📄 Gerando PDF de teste...")
print(f"   TIFF: {tiff_path}")
print(f"   Shape: {shape_path}")
print(f"   PDF: {pdf_path}")

success = create_fertility_report(
    output_path=str(pdf_path),
    property_name="Ponte de Pedra",
    owner_name="CELSO GRIESANG",
    plot_name="Todos os Talhões",
    crop_season="24/25",
    depth="0-20 cm",
    area_hectares=1496.27,
    interpolations=interpolations,
    tiff_files=tiff_files,
    logo_path=str(logo_path) if logo_path.exists() else None,
    boundary_shapefile=str(shape_path)
)

if success:
    print(f"\n✅ PDF gerado com sucesso: {pdf_path}")
else:
    print(f"\n❌ Erro ao gerar PDF")
    sys.exit(1)
