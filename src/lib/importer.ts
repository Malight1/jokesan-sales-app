import * as XLSX from 'xlsx';
import { customers, suppliers, materials, finishedGoods } from './api';

// ---- parse an uploaded file into an array of row-objects ----
export async function parseSpreadsheet(file: File): Promise<Record<string, any>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
}

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  type?: 'text' | 'number';
  synonyms?: string[];   // for auto-guessing the source column
}

export interface EntityDef {
  id: string;
  label: string;
  fields: FieldDef[];
  create: (row: Record<string, any>) => Promise<any>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Guess which source header maps to a field, by matching synonyms.
export function autoGuess(field: FieldDef, headers: string[]): string {
  const targets = [field.key, field.label, ...(field.synonyms ?? [])].map(norm);
  for (const h of headers) {
    const nh = norm(h);
    if (targets.some(t => nh === t || nh.includes(t) || t.includes(nh))) return h;
  }
  return '';
}

const num = (v: any) => {
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

export const ENTITIES: EntityDef[] = [
  {
    id: 'customers',
    label: 'Customers',
    fields: [
      { key: 'first_name', label: 'First Name', required: true, synonyms: ['name', 'firstname'] },
      { key: 'last_name', label: 'Last Name', synonyms: ['surname', 'lastname'] },
      { key: 'company_store', label: 'Company / Store', synonyms: ['company', 'business', 'store', 'shop'] },
      { key: 'phone', label: 'Phone', synonyms: ['phonenumber', 'mobile', 'tel', 'contact'] },
      { key: 'address', label: 'Address', synonyms: ['location'] },
    ],
    create: r => customers.create({
      first_name: r.first_name, last_name: r.last_name, company_store: r.company_store,
      phone: r.phone, address: r.address,
    }),
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    fields: [
      { key: 'first_name', label: 'First Name', required: true, synonyms: ['name', 'firstname', 'contact'] },
      { key: 'last_name', label: 'Last Name', synonyms: ['surname', 'lastname'] },
      { key: 'company_store', label: 'Company', synonyms: ['company', 'business', 'store'] },
      { key: 'phone', label: 'Phone', synonyms: ['phonenumber', 'mobile', 'tel'] },
      { key: 'email', label: 'Email', synonyms: ['mail'] },
      { key: 'address', label: 'Address', synonyms: ['location'] },
    ],
    create: r => suppliers.create({
      first_name: r.first_name, last_name: r.last_name, company_store: r.company_store,
      phone: r.phone, email: r.email, address: r.address,
    }),
  },
  {
    id: 'materials',
    label: 'Raw Materials',
    fields: [
      { key: 'name', label: 'Material Name', required: true, synonyms: ['material', 'item', 'rawmaterial'] },
      { key: 'unit', label: 'Unit', synonyms: ['uom', 'measure'] },
      { key: 'type_of_material', label: 'Type', synonyms: ['category', 'materialtype'] },
      { key: 'qty_balance', label: 'Opening Qty', type: 'number', synonyms: ['quantity', 'stock', 'balance', 'openingstock'] },
      { key: 'min_stock_level', label: 'Min Level', type: 'number', synonyms: ['reorder', 'minimum', 'reorderpoint'] },
    ],
    create: r => materials.create({
      name: r.name, unit: r.unit,
      type_of_material: /pack/i.test(r.type_of_material) ? 'Packaging Material' : 'Raw Material',
      qty_balance: num(r.qty_balance), min_stock_level: num(r.min_stock_level) || 10,
    }),
  },
  {
    id: 'finished_goods',
    label: 'Finished Goods',
    fields: [
      { key: 'name', label: 'Product Name', required: true, synonyms: ['product', 'item', 'goods'] },
      { key: 'unit', label: 'Unit', synonyms: ['uom', 'measure'] },
      { key: 'selling_price', label: 'Selling Price', type: 'number', synonyms: ['price', 'sellingprice', 'amount'] },
      { key: 'qty_balance', label: 'Opening Stock', type: 'number', synonyms: ['quantity', 'stock', 'balance'] },
      { key: 'min_stock_level', label: 'Min Level', type: 'number', synonyms: ['reorder', 'minimum'] },
    ],
    create: r => finishedGoods.create({
      name: r.name, unit: r.unit || 'pcs',
      selling_price: num(r.selling_price),
      qty_balance: num(r.qty_balance), min_stock_level: num(r.min_stock_level) || 10,
      default_markup: 1.5,
    }),
  },
];

// Build a downloadable template workbook for an entity.
export function downloadTemplate(entity: EntityDef) {
  const headers = entity.fields.map(f => f.label);
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, `${entity.id}-template.xlsx`);
}
