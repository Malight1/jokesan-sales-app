export interface Customer {
  Customer_ID: number;
  First_name: string;
  Last_name: string;
  Company_store: string;
  Address: string;
  Customer_type: number;
}

export interface Supplier {
  Supplier_ID: number;
  First_name: string;
  Last_name: string;
  Company_store: string;
  Address: string;
  Email: string;
  Phone_no: string;
}

export interface Material {
  ID: number;
  Material: string;
  Unit: string;
  Type_of_material: string;
  qty_Balance: number;
}

export interface FinishedGood {
  Transaction_ID: number;
  ProductionID: number;
  Date_of_production: string;
  Finished_goods_id: number;
  qty_produced: number;
  unit_cost: number;
  Total_cost: number;
  Selling_Price: number;
  Processed: boolean;
}

export interface Production {
  ProductionID: number;
  Date_of_production: string;
  Finished_Goods_ID: number;
  Expenses: number;
  total_cost: number;
  unit_cost: number;
  qty_produced: number;
}

export interface FgBatch {
  batch_ID: number;
  Production_id: number;
  product: number;
  qty: number;
  qty_remaining: number;
  unit_cost: number;
  Selling_price: number;
  date_of_production: string;
}

export interface SaleMain {
  Transaction_ID: number;
  Date_of_transaction: string;
  Payment_type: number;
  PaymentStatus: string;
  Customer_Id: number;
  TotalAmount: number;
  AmountPaid: number;
  Balance: number;
  Reference: string;
  Notes: string;
  Processed: boolean;
}

export interface SaleItem {
  Transaction_ID: number;
  SaleID: number;
  Date_of_Transaction: string;
  Product: number;
  quantity: number;
  Unit_Price: number;
  Payment_type: number;
  Amount: number;
  Processed: boolean;
}

export interface SalePayment {
  PaymentID: number;
  Transaction_ID: number;
  PaymentDate: string;
  AmountPaid: number;
  PaymentType: number;
  PaymentStatus: string;
  Reference: string;
  Notes: string;
}

export interface PurchaseMain {
  Purchase_No: number;
  SupplierID: number;
  PurchaseDate: string;
  TotalAmount: number;
  TotalPaid: number;
  Balance: number;
  Payment_type: string;
  PaymentStatus: string;
  Processed: boolean;
}

export interface PurchaseItem {
  Purchase_No: number;
  PurchaseID: number;
  Date_of_purchase: string;
  Product: number;
  qty: number;
  qty_remaining: number;
  Cost_Price: number;
  Amount: number;
}

export interface PurchasePayment {
  PaymentID: number;
  Purchase_No: number;
  PaymentDate: string;
  AmountPaid: number;
  PaymentType: number;
  PaymentStatus: string;
  Reference: string;
  Notes: string;
}

export interface Expense {
  ID: number;
  Date_of_expense: string;
  Type_of_expense: string;
  Description: string;
  Amount: number;
  Payment_type: string;
}

export interface StockMovement {
  MovementID: number;
  ProductID: number;
  TransactionID: number;
  MovementType: string;
  Quantity: number;
  MovementDate: string;
  UserName: string;
}

export interface BOMItem {
  BOM_ID: number;
  Material_ID: number;
  Quantity: number;
  Unit: string;
}
