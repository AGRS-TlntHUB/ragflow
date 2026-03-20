import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IKnowledge } from '@/interfaces/database/knowledge';
import evaluationService from '@/services/evaluation-service';
import kbService, { listDataset } from '@/services/knowledge-service';
import { formatDate, formatSecondsToHumanReadable } from '@/utils/date';
import { useQuery } from '@tanstack/react-query';
import { message } from 'antd';
import { LucideSend, LucideSettings, LucideTrash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EvaluationRun = {
  id: string;
  dataset_id: string;
  dialog_id: string;
  name?: string;
  status: string;
  create_time: number;
  complete_time?: number;
};

type EvaluationResult = {
  id: string;
  case_id: string;
  generated_answer: string;
  execution_time: number;
  retrieved_chunks?: Record<string, unknown>[];
};

type EvaluationCase = {
  id: string;
  question: string;
  metadata?: {
    answer_type?: string;
    source_question?: string;
  };
};

type EvalTemplate = {
  id: string;
  evalType: string;
  datasetId: string;
  datasetPath: string;
  datasetContent: string;
};

const SINGLE_SHOT_CHAT_EVAL_TYPE = 'Single-Shot Chat';
const DEFAULT_EVAL_DIALOG_ID = 'b50544e222a411f18adca3e91c097350';
const DEFAULT_DATASET_ID = '40a87156208711f1baf59b17f42910d4';
const SECONDARY_DATASET_ID = '470ca978230b11f1a4515d149fc7902a';
const DEFAULT_QUESTIONS_DATASET_PATH =
  'data_saved/public_dataset/1_question.json';
const DEFAULT_QUESTIONS_DATASET_CONTENT = `[
  {
    "question": "Who were the claimants in case CFI 010/2024?",
    "answer_type": "names",
    "id": "cdddeb6a063f29cbea5f10b3dccbd83aa16849e1f3124e223d141d1578efeb0a"
  }
]`;
const ALL_TYPES_MINIMAL_DATASET_PATH =
  'data_saved/public_dataset/all_types_questions_minimal.json';
const ALL_TYPES_MINIMAL_DATASET_CONTENT = `[
  {
    "question": "Who were the claimants in case CFI 010/2024?",
    "answer_type": "names",
    "id": "cdddeb6a063f29cbea5f10b3dccbd83aa16849e1f3124e223d141d1578efeb0a"
  },
  {
    "question": "Summarize the court's final ruling in case CFI 010/2024.",
    "answer_type": "free_text",
    "id": "6618184ee84fbebc360162dc3825868eec4e5e81aae1901eb18a8e741fd323f3"
  },
  {
    "question": "Was the main claim or application in case ARB 034/2025 approved or granted by the court?",
    "answer_type": "boolean",
    "id": "df0f24b2b339c62162b82eb3add3a2a71a275ee768fbb2835ccdd66bc79cd04f"
  },
  {
    "question": "What was the claim value referenced in the appeal judgment CA 005/2025?",
    "answer_type": "number",
    "id": "d204a13070fd2f18eb3e9e939fdc80855a915dfafd7f49f8fc8e80d6a3d7637b"
  },
  {
    "question": "Which case was decided earlier: CFI 016/2025 or ENF 269/2023?",
    "answer_type": "name",
    "id": "b9dc2dae206c155bc5936c971272e8154d22b4f9e3fa65795eb8b49a80d26b6f"
  },
  {
    "question": "On what date was the Employment Law Amendment Law enacted?",
    "answer_type": "date",
    "id": "dd97e6cdec41ef77576ed86e037565fc88ff891edcdd39018e2d062e28f9605f"
  }
]`;
const PUBLIC_DATASET_PATH = 'data/public_dataset.json';
const PUBLIC_DATASET_CONTENT = `[
  {
    "question": "Who were the claimants in case CFI 010/2024?",
    "answer_type": "names",
    "id": "cdddeb6a063f29cbea5f10b3dccbd83aa16849e1f3124e223d141d1578efeb0a"
  },
  {
    "question": "Summarize the court's final ruling in case CFI 010/2024.",
    "answer_type": "free_text",
    "id": "6618184ee84fbebc360162dc3825868eec4e5e81aae1901eb18a8e741fd323f3"
  },
  {
    "question": "Was the main claim or application in case ARB 034/2025 approved or granted by the court?",
    "answer_type": "boolean",
    "id": "df0f24b2b339c62162b82eb3add3a2a71a275ee768fbb2835ccdd66bc79cd04f"
  },
  {
    "question": "What was the claim value referenced in the appeal judgment CA 005/2025?",
    "answer_type": "number",
    "id": "d204a13070fd2f18eb3e9e939fdc80855a915dfafd7f49f8fc8e80d6a3d7637b"
  },
  {
    "question": "Which articles of Law No. 12 of 2004 are explicitly superseded by Law No. 16 of 2011, and what is the overarching theme of the content in Article 4 of Law No. 12 of 2004 that was superseded?",
    "answer_type": "free_text",
    "id": "c595f1180b440f4e6ea5e130563fb4c2e9705557d3abf10e401948c0eb73b268"
  },
  {
    "question": "How does Law No. 1 of 2025 modify the application of the Data Protection Law 2020 as it pertains to processing Personal Data in the DIFC by a Controller or Processor, as originally outlined in the Data Protection Law 2020?",
    "answer_type": "free_text",
    "id": "eeae1069cbbc9ef2fe66f063459ddac4c5ff5edef405593bb299aca715246b39"
  },
  {
    "question": "List all respondents in case ARB 034/2025.",
    "answer_type": "names",
    "id": "d64868661e961ce09219969e101edd52b26c8f70a2f6325209f34372e95baf44"
  },
  {
    "question": "Identify all claimants who appeared at any point in case TCD 001/2024.",
    "answer_type": "names",
    "id": "6f9c0b194e9e654d320fe873627afcd5403fd3ff3f4f939d6389e9431c20f413"
  },
  {
    "question": "Which specific DIFC Laws were amended by DIFC Law No. 2 of 2022?",
    "answer_type": "free_text",
    "id": "fcabd6aa14e2df4b7ca00fa516a70eba6de58b74dfde30270e3fe3eec6d1da7a"
  },
  {
    "question": "Which laws mention 'interpretative provisions' in their schedules?",
    "answer_type": "free_text",
    "id": "89fd4fbcdcf5c17ba256395ee64378a3f2125b081394a9568964defb28fdef75"
  },
  {
    "question": "Who has the authority to make the Dematerialised Investments Regulations (DIR), and what other laws are cited as conferring powers for these regulations?",
    "answer_type": "free_text",
    "id": "fb1de34d3ebe58b03c5e9898c2e29d1d8c6297fa570f0021967986e43b62da62"
  },
  {
    "question": "What is the title of DIFC Law No. 5 of 2018 and DIFC Law No. 4 of 2019, and when were their consolidated versions last updated?",
    "answer_type": "free_text",
    "id": "170221727c50538d8728268a4e4b0d0cb8bfac6a8b9c159d47d8ceea7f6a3bfd"
  },
  {
    "question": "What are the titles of DIFC Law No. 6 of 2013 and DIFC Law No. 3 of 2013?",
    "answer_type": "free_text",
    "id": "571f60136b26b5ce872f29817024fa60d27e8d3e49cec533d162fa48af9d4b13"
  },
  {
    "question": "Which laws were amended by DIFC Law No. 2 of 2022?",
    "answer_type": "free_text",
    "id": "2b4df6b47be14235fb3f3d5b75491ba3232be4e471db296b992446105369b60e"
  },
  {
    "question": "Which laws were amended by 'DIFC Law No. 2 of 2022'?",
    "answer_type": "free_text",
    "id": "36a833768836b02a61938fcb5914f069b6b342eaf47d1a67ca2c5acc6d71bc0e"
  },
  {
    "question": "When was the DIFC Laws Amendment Law, DIFC Law No. 8 of 2018 enacted and what law did it amend?",
    "answer_type": "free_text",
    "id": "d9c088343bcf9b1b7a17a4a92b394925494a8ae2a2f86b09d10d267179eb01bb"
  },
  {
    "question": "Which laws mention the 'Ruler of Dubai' as the legislative authority and also specify that the law comes into force on the date specified in the Enactment Notice?",
    "answer_type": "free_text",
    "id": "4aa0f4e28b151c9fb03acbccd37d724bb0f9fae137c8fdc268c6c03cd6c7c7ac"
  },
  {
    "question": "Was the Employment Law enacted in the same year as the Intellectual Property Law?",
    "answer_type": "boolean",
    "id": "bd8d0befc731315ee2a477221feb950b44e68d9596823a90c47f78fc04870870"
  },
  {
    "question": "Was the Intellectual Property Law enacted earlier in the year than the Employment Law?",
    "answer_type": "boolean",
    "id": "bb67fc19f45527933d0c7319a2c96b4bf5e782f83018254b6a0d34685b219ec5"
  },
  {
    "question": "Is the Intellectual Property Law No. 4 of 2019 administered by the same entity that administers the Trust Law No. 4 of 2018?",
    "answer_type": "boolean",
    "id": "96bccc8b15e2795578584484ea3533e71d6e044d13420cf77a32393b7502fc1c"
  },
  {
    "id": "9f9fb4b911d75c22f2c9a42bb852848ac45594179a7d0d126c8ef0ac8941b18d",
    "question": "Do cases CA 004/2025 and SCT 295/2025 involve any of the same legal entities or individuals as parties?",
    "answer_type": "boolean"
  },
  {
    "id": "737940cf4c4cd4c7f6f6d3b8b30570e853538790e06d40583631acf017eb6029",
    "question": "Is there any main party that appeared in both cases CFI 010/2024 and ENF 053/2025 at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "bfa089d55bda48890b3f84ec000ad2c3c682031ff7153cc8023efeeb8c1ff9e3",
    "question": "Was the same judge involved in both case CFI 010/2024 and case DEC 001/2025 at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "52a35cfabe76f2c538c6f72a841a08e0cc85bbe8f732874a4d2827383794c213",
    "question": "Did cases CA 004/2025 and ARB 034/2025 have any judges in common?",
    "answer_type": "boolean"
  },
  {
    "id": "54d56331536ad42544a97a57c5d700cf82d9b5b46dc2e6a08a31992d5b755fb0",
    "question": "Is there any party (claimant or defendant) common to both case TCD 001/2024 and case CFI 016/2025 at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "fba6e86a3169728c19a02ccbad9cd87599344fdd0bfd0589e5ab7bf6e16a09b9",
    "question": "Did cases DEC 001/2025 and CFI 057/2025 have any judges in common at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "1e1121d0cc14259a4f345408302ef2ddf8e474cdb9ad60a34b060bd789b95298",
    "question": "Do cases DEC 001/2025 and SCT 514/2025 involve any of the same legal entities or individuals as main parties at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "3c19ecbe27fe9701f742589a927a11a5b701f064e49d35d631deef0d478aa99f",
    "question": "Was the same judge involved in both case DEC 001/2025 and case TCD 001/2024 at any point?",
    "answer_type": "boolean"
  },
  {
    "id": "2d436eb3d28cb6d4eacebcb6d703e402800a56bc2f8b4d4185ea5961d5e53960",
    "question": "Identify whether any person or company is a main party to both CA 005/2025 and CFI 067/2025 at any point.",
    "answer_type": "boolean"
  },
  {
    "question": "What are the common elements found in the interpretation sections of the Operating Law 2018, Trust Law 2018, and Common Reporting Standard Law 2018?",
    "answer_type": "free_text",
    "id": "acd3200d75f4507d2cfbbcb1c568d7adf8da409063bee2e2e0b7832c4894a5a9"
  },
  {
    "question": "What entity administers the Leasing Law 2020 and the Trust Law 2018?",
    "answer_type": "free_text",
    "id": "4ce050c0d6261bf3ee2eafa9c7d5fc7273e390a4a1c09ab6e26f691c68199d1b"
  },
  {
    "question": "Which laws are administered by the Registrar and were enacted in 2004?",
    "answer_type": "free_text",
    "id": "6351cfe2534da67df395e52e3370b7b5f724a1ac5d23e053b3d8ebc88a5f634c"
  },
  {
    "question": "What are the common elements found in Schedule 1 of the Operating Law 2018 and the Trust Law 2018?",
    "answer_type": "free_text",
    "id": "b4d8c1cc3b6017107e2f566421d5548b95844e6fa9f6c9e40a695f4bbc11ee6a"
  },
  {
    "question": "Which laws, enacted in 2018, include provisions relating to the application of the Arbitration Law in their Schedule 2?",
    "answer_type": "free_text",
    "id": "5d8fd8335f98f500b33d96269161657f4493445e6fc6afc5f2a4baba3bd49a3e"
  },
  {
    "question": "What is the prescribed penalty for an offense against the Strata Title Law under the Strata Title Regulations, and what is the penalty for using leased premises for an illegal purpose under the Leasing Regulations?",
    "answer_type": "free_text",
    "id": "8d481702ddfb40310a070ac44f4a2e9637043f453afa0319cd83d20fd8ec607e"
  },
  {
    "question": "What is the common commencement date for the DIFC Laws Amendment Law, DIFC Law No. 3 of 2024, and the Law of Security Law, DIFC Law No. 4 of 2024?",
    "answer_type": "free_text",
    "id": "e14388d8fe61056e07ce155e692acf4552e070e0ee88d73b20c15c3c750dbc0d"
  },
  {
    "question": "How do the Limited Liability Partnership Law and the Non Profit Incorporated Organisations Law define their administration?",
    "answer_type": "free_text",
    "id": "54103603d632383a733ea81fe983eac4982a22bbd77f1e8a0daa333c249cd5c9"
  },
  {
    "question": "Which laws mention the Ruler of Dubai as the legislative authority and were enacted in 2018?",
    "answer_type": "free_text",
    "id": "115a9bca032550a20271240b8785b922d35a7117f7f1760250eba1c34345be9e"
  },
  {
    "question": "Which laws explicitly mention the Companies Law 2018 and the Insolvency Law 2009 in their regulations concerning company structures?",
    "answer_type": "free_text",
    "id": "2180c75894515d7db767c477c26326e97f1cd69c17c4f1746706e859f2d0e10d"
  },
  {
    "question": "What is the commencement date for the Data Protection Law 2020 and the Employment Law 2019?",
    "answer_type": "free_text",
    "id": "1107e2844571d4c05755c1607e1a847a54fc023777f8b4f87e2ac50d5256c3d8"
  },
  {
    "question": "Which laws are administered by the Registrar and what are their respective citation titles?",
    "answer_type": "free_text",
    "id": "b909797db886eacd0f6264bf87649f2ada41f9b7d6c02bc12fe7ea21a02a7418"
  },
  {
    "question": "What are the effective dates for pre-existing and new accounts under the Common Reporting Standard Law 2018, and what is the date of its enactment?",
    "answer_type": "free_text",
    "id": "f35f42eba75cda26f5f6439caee02d4c5ef2648ec6d61831f1324c0f631ea10a"
  },
  {
    "id": "8e3b4683596d94dbc9a66f20104329939e0e8d4da1e1dbf6df5784247c2ea373",
    "question": "Was the same judge involved in both case CA 005/2025 and case TCD 001/2024 at any point?",
    "answer_type": "boolean"
  },
  {
    "question": "Which laws were made by the Ruler of Dubai and their commencement date is specified in an Enactment Notice?",
    "answer_type": "free_text",
    "id": "6e8d0c41f3e5b8a5383db8964a64254de33aec88f0c7abea793c37ecf4c4db43"
  },
  {
    "id": "b9dc2dae206c155bc5936c971272e8154d22b4f9e3fa65795eb8b49a80d26b6f",
    "question": "Which case was decided earlier: CFI 016/2025 or ENF 269/2023?",
    "answer_type": "name"
  },
  {
    "id": "0f6e75bde356a184b0fa69f0568c29290fb8adf42b5409ab4d2e7e1c193295dd",
    "question": "Which case was decided earlier: ENF 269/2023 or SCT 169/2025?",
    "answer_type": "name"
  },
  {
    "id": "d9d27c9cace6eafd11dbb349244e0443e16c8cc0efdf516514cc945135e1a597",
    "question": "Between ARB 034/2025 and SCT 295/2025, which was issued first?",
    "answer_type": "name"
  },
  {
    "id": "3dc92e33b028436ab27768b30c91d5c53f0527acb35f8378f55131fc77f628bf",
    "question": "Which case has an earlier decision date: CFI 010/2024 or SCT 169/2025?",
    "answer_type": "name"
  },
  {
    "id": "fbe661b99e48c27ade90fbce66ae359902f15f2351774dd29c00f41c62f72c80",
    "question": "Which case was decided earlier: CA 004/2025 or SCT 295/2025?",
    "answer_type": "name"
  },
  {
    "id": "d4157e6a3b7b321d042a7d5db7cf2e829317d818e4f2d56ea2399c5547f95b42",
    "question": "Which case was decided earlier: ENF 269/2023 or SCT 514/2025?",
    "answer_type": "name"
  },
  {
    "id": "8f104743e21eef9d7218950d7a7a1eade455fafb809ba01a923c1d88f0493c8f",
    "question": "Identify the case ID with the higher monetary amount: ARB 032/2025 or CFI 067/2025?",
    "answer_type": "name"
  },
  {
    "question": "Does the term 'Law' in the Strata Title Regulations refer to the same law number as the 'Employment Law' mentioned in the Employment Regulations?",
    "answer_type": "boolean",
    "id": "46927f372acef1888a11ef8de5f7a1dff5588a85efc12eaafe7c7f59c5fbf14f"
  },
  {
    "question": "Was the Strata Title Law Amendment Law, DIFC Law No. 11 of 2018, enacted on the same day as the Financial Collateral Regulations came into force?",
    "answer_type": "boolean",
    "id": "b249b41b7ff44ce4d5686bb8b9e0533e4874f5482a2594f49d60edf11b04f1ac"
  },
  {
    "question": "Was the Leasing Law enacted in the same year as the Real Property Law Amendment Law?",
    "answer_type": "boolean",
    "id": "d5bc744160e9f3690c91cd3ee29e601a00444ac66a53b0e8e4d7991e1bf7de20"
  },
  {
    "question": "Did the DIFC Law Amendment Law (DIFC Law No. 1 of 2024) come into force on the same date as the Digital Assets Law (DIFC Law No. 2 of 2024)?",
    "answer_type": "boolean",
    "id": "af8d46901ce0daf134701c809e7ae02f5682b9676a20a226b61eaa40512dbc4e"
  },
  {
    "question": "What is the law number of the Employment Law Amendment Law?",
    "answer_type": "number",
    "id": "7700103c51940db23ba51a0efefbef679201af5b0a60935853d10bf81a260466"
  },
  {
    "question": "In what year was the Employment Law Amendment Law enacted?",
    "answer_type": "number",
    "id": "4cbb1883a9d09e09cbf273aea34dd9ce104eacf5ffa1b3e95e2a5c18440f778c"
  },
  {
    "question": "What is the full title of the enacted law?",
    "answer_type": "name",
    "id": "82664b585f15bcd8afa3bd6acf97c3fa415fcad7d60762d8ad80421418caf3f5"
  },
  {
    "question": "On what date was the Employment Law Amendment Law enacted?",
    "answer_type": "date",
    "id": "dd97e6cdec41ef77576ed86e037565fc88ff891edcdd39018e2d062e28f9605f"
  },
  {
    "question": "Does the enactment notice specify a precise calendar date for the law to come into force?",
    "answer_type": "boolean",
    "id": "4ced374a0c805f11161598ee003019f841de3c03da4f478c1b7cea81d58bc4bc"
  },
  {
    "question": "Is the common law (including the principles and rules of equity) supplementary to DIFC Statute?",
    "answer_type": "boolean",
    "id": "9c07044aaf43ecb41e350a77749e6a6963c37dfd39420117e0b928f436098925"
  },
  {
    "question": "What is the law number for the 'Law on the Application of Civil and Commercial Laws in the DIFC'?",
    "answer_type": "number",
    "id": "f032929682fae6c65c184050d97635e4024703a6d40ed3028a9dde70856ecfad"
  },
  {
    "question": "Does this Law apply in the jurisdiction of the Dubai International Financial Centre?",
    "answer_type": "boolean",
    "id": "b52c749fc01ddd233879c576270e8367452f273227e8c5090f678ea37641f542"
  },
  {
    "question": "What is the latest DIFC Law number that amended the 'Law on the Application of Civil and Commercial Laws in the DIFC'?",
    "answer_type": "number",
    "id": "be535a44eec463ed7edfac6f145990d962ea6394f22877b7c991c6140433e056"
  },
  {
    "question": "What is the law number of the Data Protection Law?",
    "answer_type": "number",
    "id": "f378457dc4e9f78aa2ce25dde7449a5400b853217f8ebda07a8654a015b15021"
  },
  {
    "question": "According to Article 14(2)(b) of the General Partnership Law 2004, how many years must a Recognised Partnership's Accounting Records be preserved?",
    "answer_type": "number",
    "id": "146567e3d096312584103b24983e3ff8e904e4ec5dea993d9774d24fef15fce7"
  },
  {
    "question": "Under Article 17(b) of the General Partnership Law 2004, can a person become a Partner without the consent of all existing Partners, unless otherwise agreed?",
    "answer_type": "boolean",
    "id": "6976d6d247c5a260ebe90eb4ebf418998d7642f5e4e60845d6d49cb8fb145dec"
  },
  {
    "question": "According to Article 19(4) of the General Partnership Law 2004, how many months after the end of the financial year must the accounts for that year be prepared and approved by the Partners?",
    "answer_type": "number",
    "id": "322674cd65809bde505d9f50edb1bf7e1674f7e118a8179617732a3942b52d74"
  },
  {
    "question": "According to Article 34(1) of the General Partnership Law 2004, is a person admitted as a Partner into an existing General Partnership liable to creditors for anything done before they became a Partner?",
    "answer_type": "boolean",
    "id": "47cb314acde5887a03dc25c4f36992ad801e5fa7565d8288af88491f60c53fd5"
  },
  {
    "question": "Under Article 23 of the Personal Property Law 2005, is a restriction on transfer of a security imposed by the issuer effective against a person who had actual knowledge of such third party property interest, if the security is uncertificated and the registered owner has been notified of the restriction?",
    "answer_type": "boolean",
    "id": "117267649104e2ac88d57b64c615721dc2b3f0631b7d4914f6f85323651e8cb4"
  },
  {
    "question": "According to Article 10 of the Real Property Law 2018, does freehold ownership of Real Property carry the same rights and obligations as ownership of an estate in fee simple under English common law and equity?",
    "answer_type": "boolean",
    "id": "75bf397c92fcaee5bf25f9e869454c21c77972e8280c746e33635612ecddda33"
  },
  {
    "question": "Under Article 12 of the Real Property Law 2018, what is the term for the office created as a corporation sole?",
    "answer_type": "name",
    "id": "613217268c14e7aa3f190f7d8b43610f2ffdae2cf15a4f8d7a3acfa52cefeedb"
  },
  {
    "question": "Under the Common Reporting Standard Law 2018, is the Relevant Authority liable for acts or omissions in its performance of functions if the act or omission is shown to have been in bad faith?",
    "answer_type": "boolean",
    "id": "6e3abab5157d5897a698c91d0c980646b14e5cc1e773e6c6537e918dcb26275e"
  },
  {
    "question": "According to Article 12(4) of the Common Reporting Standard Law 2018, for how many years must records be retained by Reporting Financial Institutions after the date of reporting the information?",
    "answer_type": "number",
    "id": "3ab3489605bc64891f36d9f3c7cf9c8608d08163b8673db41aa359097786b4bc"
  },
  {
    "question": "If the Relevant Authority confirms a fine or action after an appeal under Article 21(5) of the Common Reporting Standard Law 2018, how many business days does the Reporting Financial Institution have to pay the fine or perform the action?",
    "answer_type": "number",
    "id": "e0798bd394af022603f1ed7a09641de2bb414bd14a9d6a2c494980c86095ccff"
  },
  {
    "question": "According to Article 8(2)(a) of the DIFC Contract Law 2004, what is the minimum age a natural person must attain to have competent legal capacity?",
    "answer_type": "number",
    "id": "230b6411c31b25717cb6271824274dd9ebc1cb2575c3ec622ffee06c2aea51e1"
  },
  {
    "question": "Under Article 15(1) of the Strata Title Law DIFC Law No. 5 of 2007, what entity holds ownership of the Common Property in trust for the Owners in the Strata Scheme?",
    "answer_type": "name",
    "id": "06034335eee6dbe0df799fd5ce57e8f311ac8ad693dbeeb8dad4edaa9edb53eb"
  },
  {
    "question": "According to Article 17(1) of the Strata Title Law DIFC Law No. 5 of 2007, what type of resolution is required for a Body Corporate to sell or dispose of part of the Common Property, or grant or amend a lease over part of the Common Property?",
    "answer_type": "name",
    "id": "1e1238c6119ed749321cd0addedbaeb69e68eec861acb1d122a2730e8944bf23"
  },
  {
    "question": "If a Body Corporate grants an Exclusive Use Right with respect to a part of the Common Property to an Owner, as per Article 16(2) of the Strata Title Law DIFC Law No. 5 of 2007, who are the Body Corporate's rights and liabilities with respect to that part of the Common Property vested in while the Exclusive Use Right continues?",
    "answer_type": "name",
    "id": "5b78eff477f6545504892d039a34a82fcba94b79584e925a1e231875f6892a5b"
  },
  {
    "question": "Under the Operating Law 2018, can the Registrar be held liable for acts or omissions in performing their functions if the act or omission is shown to have been in bad faith, according to Article 7(8)?",
    "answer_type": "boolean",
    "id": "b1d0245bb7c71b42f08a4cdbec612a56715295223472ac5a45af31811ada2f3b"
  },
  {
    "question": "According to Article 9(9)(a) of the Operating Law 2018, how many months does a Licence typically have effect from its issue date by the Registrar?",
    "answer_type": "number",
    "id": "7b31467fd9f391a836ecd316b258a6d5e849cb62a9a0c95573b084c1d1338ba0"
  },
  {
    "question": "Under Article 10(3) of the Operating Law 2018, how many days does a Registered Person have to change its name if it becomes misleading, deceptive, or conflicting?",
    "answer_type": "number",
    "id": "ca8aebcc86f2b1ea064a28736c67b04357474bcf1128890991c73a237091638a"
  },
  {
    "question": "Under Article 8(1) of the Operating Law 2018, is a person permitted to operate or conduct business in or from the DIFC without being incorporated, registered, or continued under a Prescribed Law or other Legislation administered by the Registrar?",
    "answer_type": "boolean",
    "id": "30ab0e56ee0c43b5bf94fd9657c7f7ac24f0e7be29ced2933437f7a234713cd7"
  },
  {
    "question": "According to Article 16(1) of the Operating Law 2018, what document must every Registered Person file with the Registrar at the same time as applying for Licence renewal?",
    "answer_type": "name",
    "id": "33060f268efcac79c65cd3e0a39bc0f7d91d9bb1802bc2e08bfa43ec5a5cd355"
  },
  {
    "question": "Under Article 22 of the Operating Law 2018, for how many years from the date the Registrar becomes aware of an act or omission can the Registrar exercise powers in respect of a former Registered Person removed from the Public Register?",
    "answer_type": "number",
    "id": "f2ea23e9f861379a5c049830b57dcb499d4e6ce51013e64d49722b5845139e22"
  },
  {
    "question": "According to Article 7(3)(j) of the Operating Law 2018, can the Registrar delegate its functions and powers to officers or employees of the DIFCA without the approval of the Board of Directors of the DIFCA?",
    "answer_type": "boolean",
    "id": "b13500141f04c86f328b49c56ba01c7bc13bce5afee9646860912718291a5c1a"
  },
  {
    "question": "Under Article 11(1) of the Limited Partnership Law 2006, can a person be both a General Partner and a Limited Partner simultaneously in the same Limited Partnership?",
    "answer_type": "boolean",
    "id": "860c44c716f4243e1db203f5a0433813245daf336355b1523170cf1da2d428e3"
  },
  {
    "question": "According to the DIFC Non Profit Incorporated Organisations Law 2012, can an Incorporated Organisation undertake Financial Services as prescribed in the General Module of the DFSA Rulebook?",
    "answer_type": "boolean",
    "id": "73510f45df2f1b3f268f4fabc89e1b98690777acb78579beabb20801b34e3fc4"
  },
  {
    "question": "Under Article 11(1) of the Employment Law 2019, is a provision in an agreement to waive minimum employment requirements void in all circumstances, except where expressly permitted by the Law?",
    "answer_type": "boolean",
    "id": "d6eb4a640e0ad690e92c1463e15f5394d36d8f5bb407f0fa4d7413c456c7a5bd"
  },
  {
    "question": "According to Article 13 of the Employment Law 2019, can an Employer employ a child who is under sixteen years of age?",
    "answer_type": "boolean",
    "id": "b31a702f36e2c43e845e13f160ebc35d3d6ea27eb66a351561a94f0ce56b8667"
  },
  {
    "question": "Under Article 14(1) of the Employment Law 2019, how many days does an Employer have to provide an Employee with a written Employment Contract after the commencement of employment?",
    "answer_type": "number",
    "id": "e59a0dc49c291402ead91342b065bc4e9ded0043d126f73dd00ba6045aae46b7"
  },
  {
    "question": "According to Article 14(2)(l) of the Employment Law 2019, what is the maximum probation period for an Employee, except in specific fixed-term contract circumstances?",
    "answer_type": "number",
    "id": "be09fbfe4d36f6d9d97d997aa516b7ee5b4dc9ba988258d2310debcb1d2e320a"
  },
  {
    "question": "Under Article 16(1)(c) of the Employment Law 2019, what type of remuneration (gross or net) must an Employer keep records of, where applicable?",
    "answer_type": "name",
    "id": "cd0c8f3606da668fbc82f446657caa9cf1018f395bb15fa64b059d4809f69c88"
  },
  {
    "question": "According to Article 10 of the Employment Law 2019, how many months after the Termination Date must a claim under this Law be presented to the Court, unless otherwise specified?",
    "answer_type": "number",
    "id": "e153746c20cc385a520728ac381151f424c9eee10e4c582904fee70afe9af243"
  },
  {
    "question": "Under Article 11(2)(b) of the Employment Law 2019, can an Employee waive any right under this Law by entering into a written agreement with their Employer to terminate employment, provided they were given an opportunity to receive independent legal advice or took part in mediation?",
    "answer_type": "boolean",
    "id": "0149374f1699ab209f6169cffcdd94f45072fca07fbf7a580720760f5c32f658"
  },
  {
    "question": "According to Article 28(4) of the DIFC Trust Law 2018, can an order made consequential to a declaration under Articles 24 to 27 prejudice a purchaser in good faith for value of trust property without notice of the voidable matters?",
    "answer_type": "boolean",
    "id": "32bb32856c65215eddb17d2b5b938f58b4bec525af96f8637686e33b0d696e89"
  },
  {
    "id": "5bf060b3f9965c46f19e59c4d9afa555d6a1b04e9b9675ed35ef6b85249bb811",
    "question": "What did the jury decide in case ENF 053/2025?",
    "answer_type": "free_text"
  },
  {
    "id": "84941458c4ade946dae84cf5ebc4abf362a6f6e6fec835ba5c43ad2d3b4b14d7",
    "question": "Is there any information about parole hearings in case CFI 057/2025?",
    "answer_type": "free_text"
  },
  {
    "id": "89f4b2e86cf7e48e185b9d5775d67e7c8a51beccbb20abce8dac2a1b0e80b723",
    "question": "Were the Miranda rights properly administered in case ENF 269/2023?",
    "answer_type": "free_text"
  },
  {
    "id": "cb9cb3ecb09af7477b20abee3d5f9567c09a99fb6f4840daf933da74680ef030",
    "question": "What was the plea bargain in case ARB 032/2025?",
    "answer_type": "free_text"
  }
]`;

const buildTemplateId = () =>
  `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const createTemplate = (
  evalType: string = SINGLE_SHOT_CHAT_EVAL_TYPE,
  datasetId: string = DEFAULT_DATASET_ID,
  datasetPath: string = DEFAULT_QUESTIONS_DATASET_PATH,
  datasetContent: string = DEFAULT_QUESTIONS_DATASET_CONTENT,
): EvalTemplate => ({
  id: buildTemplateId(),
  evalType,
  datasetId,
  datasetPath,
  datasetContent,
});

const resolveDatasetContentByPath = (datasetPath: string) => {
  if (datasetPath === DEFAULT_QUESTIONS_DATASET_PATH) {
    return DEFAULT_QUESTIONS_DATASET_CONTENT;
  }
  if (datasetPath === ALL_TYPES_MINIMAL_DATASET_PATH) {
    return ALL_TYPES_MINIMAL_DATASET_CONTENT;
  }
  if (datasetPath === PUBLIC_DATASET_PATH) {
    return PUBLIC_DATASET_CONTENT;
  }
  return DEFAULT_QUESTIONS_DATASET_CONTENT;
};

const getTemplateRunTag = (templateId: string) => `[tpl:${templateId}]`;

const formatDatasetPathForCard = (datasetPath: string) => {
  if (!datasetPath) {
    return '-';
  }
  const normalized = datasetPath.replace(/\\/g, '/');
  const fileName = normalized.split('/').filter(Boolean).pop() || normalized;
  return `.../${fileName}`;
};

const formatQuestionWithAnswerType = (
  question: string,
  answerType?: string,
) => {
  if (!answerType) {
    return question;
  }
  return `${question}\n\nRequested answer type: ${answerType}.\nReturn only in this format.`;
};

const buildCasesFromDatasetContent = (datasetContent: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(datasetContent);
  } catch {
    throw new Error('Dataset file is not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Dataset file must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('Dataset file is empty');
  }

  return parsed.map((item, idx) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Dataset entry #${idx + 1} must be an object`);
    }
    const row = item as Record<string, unknown>;
    const rawQuestion = row.question;
    if (typeof rawQuestion !== 'string' || !rawQuestion.trim()) {
      throw new Error(`Dataset entry #${idx + 1} has missing/empty "question"`);
    }

    const question = rawQuestion.trim();
    const rawAnswerType = row.answer_type;
    const answerType =
      typeof rawAnswerType === 'string' && rawAnswerType.trim()
        ? rawAnswerType.trim()
        : undefined;

    const metadata: Record<string, unknown> = {};
    if (row.id !== null && row.id !== undefined && row.id !== '') {
      metadata.source_id = row.id;
    }
    if (answerType) {
      metadata.answer_type = answerType;
      metadata.source_question = question;
    }

    const caseData: Record<string, unknown> = {
      question: formatQuestionWithAnswerType(question, answerType),
    };
    if (Object.keys(metadata).length > 0) {
      caseData.metadata = metadata;
    }
    return caseData;
  });
};

export default function Evals() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<EvalTemplate[]>([
    createTemplate(
      SINGLE_SHOT_CHAT_EVAL_TYPE,
      DEFAULT_DATASET_ID,
      DEFAULT_QUESTIONS_DATASET_PATH,
      DEFAULT_QUESTIONS_DATASET_CONTENT,
    ),
    createTemplate(
      SINGLE_SHOT_CHAT_EVAL_TYPE,
      DEFAULT_DATASET_ID,
      ALL_TYPES_MINIMAL_DATASET_PATH,
      ALL_TYPES_MINIMAL_DATASET_CONTENT,
    ),
    createTemplate(
      SINGLE_SHOT_CHAT_EVAL_TYPE,
      SECONDARY_DATASET_ID,
      PUBLIC_DATASET_PATH,
      PUBLIC_DATASET_CONTENT,
    ),
  ]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [settingsTemplateId, setSettingsTemplateId] = useState<string>('');
  const [runningTemplateId, setRunningTemplateId] = useState('');
  const [pendingRunTemplateId, setPendingRunTemplateId] = useState('');
  const [isAddTemplateOpen, setIsAddTemplateOpen] = useState(false);
  const [newTemplateEvalType, setNewTemplateEvalType] = useState(
    SINGLE_SHOT_CHAT_EVAL_TYPE,
  );
  const [newTemplateDatasetPath, setNewTemplateDatasetPath] = useState('');
  const [newTemplateDatasetId, setNewTemplateDatasetId] = useState('');
  const { data: availableDatasets = [], isFetching: availableDatasetsLoading } =
    useQuery<IKnowledge[]>({
      queryKey: ['evalTemplateAvailableDatasets', isAddTemplateOpen],
      enabled: isAddTemplateOpen,
      queryFn: async () => {
        const { data } = await listDataset(
          {
            page: 1,
            page_size: 1000,
          },
          {},
        );
        return data?.data?.kbs || [];
      },
      staleTime: 60_000,
    });
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedResultId, setSelectedResultId] = useState<string>('');
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId),
    [templates, selectedTemplateId],
  );
  const { data: templateDatasetNames } = useQuery({
    queryKey: [
      'evalTemplateDatasetNames',
      templates
        .map((item) => item.datasetId)
        .filter(Boolean)
        .sort()
        .join(','),
    ],
    queryFn: async () => {
      const uniqueDatasetIds = Array.from(
        new Set(
          templates.map((item) => item.datasetId).filter((item) => !!item),
        ),
      );
      const entries = await Promise.all(
        uniqueDatasetIds.map(async (datasetId) => {
          try {
            const { data: response } = await kbService.get_kb_detail({
              kb_id: datasetId,
            });
            const datasetName =
              response?.code === 0 ? response?.data?.name : undefined;
            return [datasetId, datasetName || datasetId] as const;
          } catch {
            return [datasetId, datasetId] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
    enabled: templates.length > 0,
  });

  const {
    data: runsData,
    isLoading: runsLoading,
    refetch: refetchRuns,
  } = useQuery({
    queryKey: ['evaluationRuns', DEFAULT_EVAL_DIALOG_ID],
    queryFn: async () => {
      const { data: response } = await evaluationService.listEvaluationRuns(
        {
          params: {
            page: 1,
            page_size: 500,
            dialog_id: DEFAULT_EVAL_DIALOG_ID,
          },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation runs');
      }
      return response.data as { runs: EvaluationRun[]; total: number };
    },
  });

  const runs = useMemo(() => runsData?.runs || [], [runsData]);
  const runsForSelectedTemplate = useMemo(() => {
    if (!selectedTemplate) {
      return [] as EvaluationRun[];
    }
    const runTag = getTemplateRunTag(selectedTemplate.id);
    return runs.filter((run) => (run.name || '').includes(runTag));
  }, [runs, selectedTemplate]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    if (!selectedRunId && runsForSelectedTemplate.length > 0) {
      setSelectedRunId(runsForSelectedTemplate[0].id);
    }
  }, [runsForSelectedTemplate, selectedRunId]);

  useEffect(() => {
    if (!runsLoading && runsForSelectedTemplate.length === 0) {
      setSelectedRunId('');
      setSelectedResultId('');
    }
  }, [runsForSelectedTemplate, runsLoading]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    const exists = runsForSelectedTemplate.some(
      (run) => run.id === selectedRunId,
    );
    if (!exists) {
      setSelectedRunId('');
    }
  }, [runsForSelectedTemplate, selectedRunId]);

  useEffect(() => {
    if (!isAddTemplateOpen) {
      return;
    }
    if (newTemplateDatasetId) {
      return;
    }
    if (availableDatasets.length > 0) {
      setNewTemplateDatasetId(availableDatasets[0].id);
    }
  }, [
    isAddTemplateOpen,
    newTemplateDatasetId,
    availableDatasets,
    setNewTemplateDatasetId,
  ]);

  const selectedRun = useMemo(
    () => runsForSelectedTemplate.find((x) => x.id === selectedRunId),
    [runsForSelectedTemplate, selectedRunId],
  );

  const { data: runDetailData, isLoading: runDetailLoading } = useQuery({
    queryKey: ['evaluationRunDetail', selectedRun?.id || ''],
    enabled: !!selectedRun?.id,
    queryFn: async () => {
      const { data: response } = await evaluationService.getEvaluationRun(
        selectedRun!.id,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation run');
      }
      return response.data as {
        run: EvaluationRun;
        results: EvaluationResult[];
      };
    },
  });

  const { data: casesData } = useQuery({
    queryKey: ['evaluationCases', selectedRun?.dataset_id],
    enabled: !!selectedRun?.dataset_id,
    queryFn: async () => {
      if (!selectedRun?.dataset_id) {
        return { cases: [], total: 0 } as {
          cases: EvaluationCase[];
          total: number;
        };
      }
      const { data: response } =
        await evaluationService.getEvaluationDatasetCases(
          selectedRun.dataset_id,
        );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation cases');
      }
      return response.data as { cases: EvaluationCase[]; total: number };
    },
  });

  const caseMap = useMemo(() => {
    const map = new Map<string, EvaluationCase>();
    (casesData?.cases || []).forEach((item) => map.set(item.id, item));
    return map;
  }, [casesData]);

  const results = selectedRun ? runDetailData?.results || [] : [];
  const isSuccess = (selectedRun?.status || '').toUpperCase() === 'COMPLETED';
  const artifactPath = selectedRun ? `run_result_${selectedRun.id}.json` : '-';
  const selectedResult = useMemo(
    () => results.find((item) => item.id === selectedResultId),
    [results, selectedResultId],
  );

  useEffect(() => {
    setSelectedResultId('');
  }, [selectedRunId]);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedResultId('');
      return;
    }
    const isValid = results.some((item) => item.id === selectedResultId);
    if (!isValid) {
      setSelectedResultId(results[0].id);
    }
  }, [results, selectedResultId]);

  const handleDeleteTemplate = (templateId: string) => {
    let nextSelectedTemplateId = '';
    setTemplates((prev) => {
      const filtered = prev.filter((item) => item.id !== templateId);
      nextSelectedTemplateId = filtered[0]?.id || '';
      return filtered;
    });
    setSelectedTemplateId((prev) =>
      prev === templateId ? nextSelectedTemplateId : prev,
    );
    if (settingsTemplateId === templateId) {
      setSettingsTemplateId('');
    }
    if (pendingRunTemplateId === templateId) {
      setPendingRunTemplateId('');
    }
  };

  const handleCreateTemplate = () => {
    const datasetPath = newTemplateDatasetPath.trim();
    const datasetId = newTemplateDatasetId.trim();
    if (!datasetPath) {
      message.error('Local eval JSON dataset path is required');
      return;
    }
    if (!datasetId) {
      message.error('Dataset ID is required');
      return;
    }
    const nextTemplate = createTemplate(
      newTemplateEvalType,
      datasetId,
      datasetPath,
      resolveDatasetContentByPath(datasetPath),
    );
    setTemplates((prev) => [...prev, nextTemplate]);
    setSelectedTemplateId(nextTemplate.id);
    setIsAddTemplateOpen(false);
    setNewTemplateEvalType(SINGLE_SHOT_CHAT_EVAL_TYPE);
    setNewTemplateDatasetPath('');
    setNewTemplateDatasetId('');
  };

  const handleRunTemplate = async (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    try {
      if (!template.datasetId?.trim()) {
        throw new Error('Template dataset ID is required');
      }
      if (!template.datasetPath?.trim()) {
        throw new Error('Questions dataset path is required');
      }
      const cases = buildCasesFromDatasetContent(template.datasetContent);
      setRunningTemplateId(templateId);

      const now = new Date();
      const timestamp = now
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 19);

      const { data: createDatasetResponse } =
        await evaluationService.createEvaluationDataset(
          {
            data: {
              name: `${template.evalType} ${timestamp}`,
              description: `Created from template ${template.evalType} (${template.datasetPath})`,
              kb_ids: [template.datasetId],
            },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (createDatasetResponse.code !== 0) {
        throw new Error(
          createDatasetResponse.message ||
            'Failed to create evaluation dataset',
        );
      }
      const datasetId = createDatasetResponse.data?.dataset_id;
      if (!datasetId) {
        throw new Error('Missing dataset_id from create dataset response');
      }

      const { data: importResponse } =
        await evaluationService.importEvaluationDatasetCases(
          {
            datasetId,
            data: { cases },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (importResponse.code !== 0) {
        throw new Error(importResponse.message || 'Failed to import cases');
      }

      const { data: startRunResponse } =
        await evaluationService.startEvaluationRun(
          {
            data: {
              dataset_id: datasetId,
              dialog_id: DEFAULT_EVAL_DIALOG_ID,
              name: `${template.evalType} run ${timestamp} ${getTemplateRunTag(template.id)}`,
            },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (startRunResponse.code !== 0) {
        throw new Error(startRunResponse.message || 'Failed to start run');
      }
      const runId = startRunResponse.data?.run_id;
      if (!runId) {
        throw new Error('Missing run_id from start run response');
      }

      setSelectedTemplateId(templateId);
      await refetchRuns();
      setSelectedRunId(runId);
      message.success('Evaluation run started');
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : 'Failed to run evaluation template',
      );
    } finally {
      setRunningTemplateId('');
    }
  };

  const stringifyValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (Array.isArray(value))
      return value.map((item) => stringifyValue(item)).join(', ');
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return '';
  };

  const getChunkField = (chunk: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const value = stringifyValue(chunk[key]);
      if (value) {
        return value;
      }
    }
    return '';
  };

  const selectedRetrievedChunks = selectedResult?.retrieved_chunks || [];
  const averageExecutionTime = useMemo(() => {
    if (results.length === 0) {
      return null;
    }
    const total = results.reduce(
      (sum, result) => sum + (result.execution_time || 0),
      0,
    );
    return total / results.length;
  }, [results]);

  return (
    <article className="size-full p-5 flex gap-4 overflow-hidden">
      <aside className="w-72 shrink-0 rounded-xl border border-border-default bg-bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Eval templates
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="p-2 space-y-1">
            {templates.map((template) => {
              const active = template.id === selectedTemplateId;
              const running = runningTemplateId === template.id;
              return (
                <div
                  key={template.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedTemplateId(template.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedTemplateId(template.id);
                    }
                  }}
                  className={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'border-accent-primary bg-accent-primary-5'
                      : 'border-border-default hover:bg-fill-tertiary'
                  }`}
                >
                  <div className="w-full text-left mb-2">
                    <div className="font-medium break-words">
                      {template.evalType}
                    </div>
                    <div className="text-xs text-text-secondary break-all mt-1">
                      {templateDatasetNames?.[template.datasetId] || '-'}
                    </div>
                    <div className="text-xs text-text-secondary break-all mt-1">
                      {formatDatasetPathForCard(template.datasetPath)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Template settings"
                      onClick={() => {
                        setSelectedTemplateId(template.id);
                        setSettingsTemplateId(template.id);
                      }}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary"
                    >
                      <LucideSettings className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Run template"
                      onClick={() => {
                        setSelectedTemplateId(template.id);
                        setPendingRunTemplateId(template.id);
                      }}
                      disabled={running}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <LucideSend className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete template"
                      onClick={() => handleDeleteTemplate(template.id)}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary"
                    >
                      <LucideTrash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="w-full rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary hover:bg-fill-tertiary"
              onClick={() => setIsAddTemplateOpen(true)}
            >
              + Add evaluation
            </button>
          </div>
        </ScrollArea>
      </aside>

      <aside className="w-64 shrink-0 rounded-xl border border-border-default bg-bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Evals
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="p-2 space-y-1">
            {runsForSelectedTemplate.map((run) => {
              const active = run.id === selectedRunId;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-accent-primary-5 text-accent-primary'
                      : 'hover:bg-fill-tertiary'
                  }`}
                >
                  {formatDate(run.create_time)}
                </button>
              );
            })}
            {!runsLoading && runsForSelectedTemplate.length === 0 && (
              <div className="px-3 py-2 text-sm text-text-secondary">
                {t('common.noData')}
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex-1 rounded-xl border border-border-default bg-bg-card flex flex-col min-h-0 overflow-hidden">
        {selectedRun ? (
          <>
            <header className="px-4 py-3 border-b border-border-default">
              <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
                <div className="text-text-secondary">Eval type</div>
                <div>
                  {selectedTemplate?.evalType || SINGLE_SHOT_CHAT_EVAL_TYPE}
                </div>
                <div className="text-text-secondary">Artifact path</div>
                <code className="break-all">{artifactPath}</code>
                <div className="text-text-secondary">Avg exec time</div>
                <div>
                  {averageExecutionTime === null
                    ? '-'
                    : formatSecondsToHumanReadable(averageExecutionTime)}
                </div>
                <div className="text-text-secondary">{t('common.action')}</div>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${isSuccess ? 'bg-state-success' : 'bg-state-error'}`}
                  />
                  <span>{isSuccess ? 'Success' : 'Failed'}</span>
                </div>
              </div>
            </header>

            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-3">
                {results.map((result) => {
                  const active = result.id === selectedResultId;
                  const caseItem = caseMap.get(result.case_id);
                  const answerType = caseItem?.metadata?.answer_type;
                  const displayQuestion =
                    caseItem?.metadata?.source_question ||
                    caseItem?.question ||
                    '-';

                  return (
                    <div
                      key={result.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedResultId(result.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedResultId(result.id);
                        }
                      }}
                      className={`w-full text-left rounded-lg border p-4 transition-colors ${
                        active
                          ? 'border-accent-primary bg-accent-primary-5'
                          : 'border-border-default bg-bg-base hover:bg-fill-tertiary'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <div className="flex items-center gap-2">
                          <div className="font-medium">Question</div>
                          {answerType && (
                            <span className="px-2 py-0.5 rounded-md text-xs bg-fill-tertiary text-text-secondary">
                              {answerType}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-secondary">
                          {formatSecondsToHumanReadable(
                            result.execution_time || 0,
                          )}
                        </div>
                      </div>
                      <div className="text-sm mb-4 break-words whitespace-pre-wrap select-text">
                        {displayQuestion}
                      </div>
                      <div className="font-medium mb-2">Answer</div>
                      <div className="text-sm break-words whitespace-pre-wrap select-text">
                        {result.generated_answer || '-'}
                      </div>
                    </div>
                  );
                })}
                {!runDetailLoading && results.length === 0 && (
                  <div className="text-sm text-text-secondary">
                    {t('common.noData')}
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-text-secondary">
            {runsLoading ? 'Loading...' : t('common.noData')}
          </div>
        )}
      </section>

      <section className="flex-1 rounded-xl border border-border-default bg-bg-card flex flex-col min-h-0 overflow-hidden">
        <header className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Retrieved chunks
          {selectedResult ? ` (${selectedRetrievedChunks.length})` : ''}
        </header>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-3">
            {selectedResult &&
              selectedRetrievedChunks.map((chunk, idx) => {
                const chunkId =
                  getChunkField(chunk, ['id', 'chunk_id', '_id']) ||
                  `#${idx + 1}`;
                const content =
                  getChunkField(chunk, [
                    'content',
                    'content_with_weight',
                    'chunk_content',
                    'text',
                    'body',
                  ]) || '-';
                const documentName =
                  getChunkField(chunk, [
                    'document_name',
                    'docnm_kwd',
                    'doc_name',
                    'doc_id',
                  ]) || '-';
                const rawChunk = stringifyValue(chunk);
                const hasFallbackFields =
                  chunkId !== `#${idx + 1}` ||
                  content !== '-' ||
                  documentName !== '-';

                return (
                  <div
                    key={`${chunkId}-${idx}`}
                    className="rounded-lg border border-border-default p-4 bg-bg-base"
                  >
                    <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
                      <div className="text-text-secondary">Chunk ID</div>
                      <code className="break-all">{chunkId}</code>
                      <div className="text-text-secondary">Document</div>
                      <div className="break-all">{documentName}</div>
                      <div className="text-text-secondary">Content</div>
                      <div className="break-words">{content}</div>
                      {!hasFallbackFields && (
                        <>
                          <div className="text-text-secondary">Raw</div>
                          <code className="break-all">{rawChunk || '-'}</code>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            {(!selectedResult || selectedRetrievedChunks.length === 0) && (
              <div className="text-sm text-text-secondary">
                {t('common.noData')}
              </div>
            )}
          </div>
        </ScrollArea>
      </section>

      <Dialog open={isAddTemplateOpen} onOpenChange={setIsAddTemplateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add evaluation template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">Eval type</div>
              <select
                value={newTemplateEvalType}
                onChange={(event) => setNewTemplateEvalType(event.target.value)}
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
              >
                <option value={SINGLE_SHOT_CHAT_EVAL_TYPE}>
                  {SINGLE_SHOT_CHAT_EVAL_TYPE}
                </option>
              </select>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">
                Local eval JSON dataset path
              </div>
              <input
                value={newTemplateDatasetPath}
                onChange={(event) =>
                  setNewTemplateDatasetPath(event.target.value)
                }
                placeholder="data/public_dataset.json"
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">Dataset ID</div>
              <select
                value={newTemplateDatasetId}
                onChange={(event) =>
                  setNewTemplateDatasetId(event.target.value)
                }
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                disabled={availableDatasetsLoading}
              >
                {availableDatasets.length === 0 && (
                  <option value="">
                    {availableDatasetsLoading
                      ? 'Loading datasets...'
                      : 'No datasets'}
                  </option>
                )}
                {availableDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} ({dataset.id})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setIsAddTemplateOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={handleCreateTemplate}
            >
              Add
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!settingsTemplateId}
        onOpenChange={(open) => !open && setSettingsTemplateId('')}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Template settings</DialogTitle>
          </DialogHeader>
          {settingsTemplateId && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm text-text-secondary">
                  Eval template type
                </div>
                <input
                  value={SINGLE_SHOT_CHAT_EVAL_TYPE}
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Dataset name</div>
                <input
                  value={
                    templateDatasetNames?.[
                      templates.find((item) => item.id === settingsTemplateId)
                        ?.datasetId || ''
                    ] || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Dataset ID</div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.datasetId || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">
                  Questions Dataset path
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                    {templates.find((item) => item.id === settingsTemplateId)
                      ?.datasetPath || '-'}
                  </div>
                  <button
                    type="button"
                    className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                    onClick={async () => {
                      const datasetPath =
                        templates.find((item) => item.id === settingsTemplateId)
                          ?.datasetPath || '';
                      if (!datasetPath) {
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(datasetPath);
                        message.success('Questions dataset path copied');
                      } catch {
                        message.error('Failed to copy path');
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setSettingsTemplateId('')}
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingRunTemplateId}
        onOpenChange={(open) => !open && setPendingRunTemplateId('')}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run evaluation?</AlertDialogTitle>
            <AlertDialogDescription>
              Run the selected eval template with current settings?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRunTemplateId('')}>
              No
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const templateId = pendingRunTemplateId;
                setPendingRunTemplateId('');
                if (templateId) {
                  void handleRunTemplate(templateId);
                }
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
